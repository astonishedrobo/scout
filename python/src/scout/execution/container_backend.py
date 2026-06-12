"""Per-session container execution backend ("Docker becomes the sandbox").

This backend runs each user/session's code inside its own short-lived sandbox
*container* instead of a bubblewrap subprocess.  It exists because ``bwrap
--unshare-user`` requires unprivileged user namespaces, which Ubuntu 23.10+ /
AppArmor and many Docker hosts block — making the bwrap path unavailable on most
deployments.  Letting the container engine provide namespace/cgroup isolation is
portable to every Docker (or Podman) host without per-host kernel/AppArmor/sysctl
tweaks.

Key design choices
------------------
* The user workspace is bind-mounted into the sandbox container **at the same
  path the worker itself sees it** (``/srv/scout-source/users/<id>``).  This keeps
  ``ExecutionPolicy`` roots, the REPL path guard, and change-detection identical
  to the bwrap path — the worker and the sandbox observe the same files through
  the same host bind, so no path translation is needed.
* Only the authenticated user's personal dir (rw) and the shared dir (ro) are
  mounted.  No secrets, no Docker socket, no other user's files.
* The persistent "alive Python shell" is a long-lived container running
  ``_repl_server.py`` and driven over stdin/stdout with the existing sentinel
  protocol — namespace state persists across calls exactly as before.

Because the worker is containerized, the bind-mount *source* must be a path on
the Docker host, not the worker's view of it.  Those host paths are supplied via
``SCOUT_WORKSPACE_USERS_HOST`` / ``SCOUT_WORKSPACE_SHARED_HOST`` (falling back to
the in-worker paths for non-containerized local runs).
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path

from ..config import ExecutionConfig
from .audit import ExecutionAuditor
from .changes import diff_snapshots, snapshot_writable_roots
from .env import build_execution_env
from .errors import ExecutionErrorCategory
from .launcher import IO_DRAIN_TIMEOUT, kill_process_tree
from .local_backend import _classify_artifacts, _command_summary, _truncate
from .models import ExecutionBackendHealth, ExecutionRequest, ExecutionResult
from .unified_exec import (
    OutputChunkCallback,
    UnifiedExecCommandRequest,
    UnifiedExecManager,
    UnifiedExecResponse,
    UnifiedExecStdinRequest,
    run_in_executor,
)
from .worker_roots import derive_user_roots

logger = logging.getLogger(__name__)

_CODE_END = "<<__END_OF_CODE__>>"
_OUTPUT_END = "<<__END_OF_OUTPUT__>>"
_MAX_OUTPUT_CHARS = 4_000

# The REPL module is launched inside the sandbox image via ``-m`` so its install
# path inside the container does not matter.
_REPL_MODULE = "scout.agent._repl_server"


# --------------------------------------------------------------------------- #
# Engine / image / host-path resolution
# --------------------------------------------------------------------------- #
def container_engine_binary() -> str | None:
    """Return the path to the configured container engine (docker/podman)."""
    engine = os.environ.get("SCOUT_CONTAINER_ENGINE", "docker")
    return shutil.which(engine)


def sandbox_image() -> str | None:
    """Image used for sandbox containers (defaults to the Scout image)."""
    return os.environ.get("SCOUT_SANDBOX_IMAGE") or None


def _host_workspace_paths() -> tuple[str, str]:
    """Host-side bind sources for the users-parent and shared dirs.

    Falls back to the worker's own view when the host paths are not set
    (correct when the worker is *not* itself containerized).
    """
    users = os.environ.get(
        "SCOUT_WORKSPACE_USERS_HOST",
        os.environ.get("SCOUT_WORKSPACE_USERS", "/srv/scout-source/users"),
    )
    shared = os.environ.get(
        "SCOUT_WORKSPACE_SHARED_HOST",
        os.environ.get("SCOUT_WORKSPACE_SHARED", "/srv/scout-source/shared"),
    )
    return users, shared


def _sandbox_network() -> str:
    """Docker network the sandbox joins when egress is approved."""
    return os.environ.get("SCOUT_SANDBOX_NETWORK", "scout-internal")


def container_engine_available() -> tuple[bool, str | None]:
    """Probe whether the container engine is reachable and an image is set."""
    binary = container_engine_binary()
    if not binary:
        return False, "container engine (docker/podman) not found on PATH"
    if not sandbox_image():
        return False, "SCOUT_SANDBOX_IMAGE not configured"
    try:
        proc = subprocess.run(
            [binary, "version", "--format", "{{.Server.Version}}"],
            capture_output=True, text=True, timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return False, f"container engine not reachable: {exc}"
    if proc.returncode != 0:
        return False, f"container engine not reachable: {(proc.stderr or '').strip()}"
    return True, None


def probe_container_isolation() -> tuple[bool, str | None]:
    """Confirm we can launch a network-off sandbox container that cannot see
    a host secret path outside its mounts."""
    ok, err = container_engine_available()
    if not ok:
        return False, err
    binary = container_engine_binary()
    image = sandbox_image()
    assert binary and image
    cmd = [
        binary, "run", "--rm",
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp",
        "--label", "scout.execution=probe",
        image,
        "/bin/sh", "-c",
        # Must NOT see the worker's secret dir, and /tmp must be writable.
        "test ! -e /srv/scout-source && touch /tmp/ok && echo probe-ok",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return False, f"container isolation probe failed: {exc}"
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0 and "probe-ok" in out:
        return True, None
    return False, f"container isolation probe failed: {out.strip()}"


# --------------------------------------------------------------------------- #
# docker run argument builder
# --------------------------------------------------------------------------- #
def _mount_args(user_id: str) -> list[str]:
    """Bind only this user's personal dir (rw) and shared dir (ro), mounted at
    the SAME paths the worker sees them so policy/guard/diff stay consistent."""
    users_host, shared_host = _host_workspace_paths()
    personal_src = str(Path(users_host) / user_id)
    personal_dst = f"/srv/scout-source/users/{user_id}"
    shared_dst = "/srv/scout-source/shared"
    return [
        "-v", f"{personal_src}:{personal_dst}:rw",
        "-v", f"{shared_host}:{shared_dst}:ro",
    ]


def _limit_args(policy) -> list[str]:
    args: list[str] = []
    if policy.max_memory_bytes:
        args += ["--memory", str(policy.max_memory_bytes)]
    if policy.max_processes:
        args += ["--pids-limit", str(policy.max_processes)]
    if policy.cpu_seconds:
        # Approximate a CPU ceiling; wall-clock timeout enforced by the caller.
        args += ["--cpus", "2"]
    return args


def _env_args(env: dict[str, str]) -> list[str]:
    args: list[str] = []
    for key, val in env.items():
        args += ["-e", f"{key}={val}"]
    return args


def _network_args(proxy_url: str | None, domains: tuple[str, ...]) -> tuple[list[str], dict[str, str]]:
    """Return (docker args, extra env). Network is OFF unless egress is approved."""
    if proxy_url and domains:
        extra = {
            "HTTP_PROXY": proxy_url, "HTTPS_PROXY": proxy_url,
            "http_proxy": proxy_url, "https_proxy": proxy_url,
            "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1",
        }
        return ["--network", _sandbox_network()], extra
    return ["--network", "none"], {}


def _base_run_args(
    request: ExecutionRequest, *, proxy_url: str | None, interactive: bool,
) -> tuple[list[str], dict[str, str]]:
    binary = container_engine_binary()
    image = sandbox_image()
    assert binary and image
    cache = request.cwd / ".scout-cache"
    env = build_execution_env(home=cache / "home", cache_dir=cache)
    net_args, net_env = _network_args(proxy_url, request.policy.network.domains)
    env.update(net_env)
    args = [
        binary, "run", "--rm",
        *(["-i"] if interactive else []),
        *net_args,
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,mode=1777",
        *_limit_args(request.policy),
        *_mount_args(request.user_id),
        "-w", str(request.cwd),
        *_env_args(env),
        "--label", "scout.execution=1",
        "--label", f"scout.user={request.user_id}",
    ]
    return args, env


# --------------------------------------------------------------------------- #
# Persistent (alive) Python shell, container-backed
# --------------------------------------------------------------------------- #
class ContainerPersistentSession:
    """Long-lived Python REPL running inside a per-session sandbox container.

    Mirrors ``PersistentSandboxSession``'s public interface (``run``, ``close``,
    ``alive``) so the worker service can use either transparently.
    """

    def __init__(
        self,
        *,
        request_user_id: str,
        session_id: str,
        cwd: Path,
        policy,
        timeout: int = 30,
    ) -> None:
        self._user_id = request_user_id
        self._session_id = session_id
        self._cwd = cwd.resolve()
        self._policy = policy
        self._timeout = timeout
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.RLock()
        self._name = f"scout-sb-{request_user_id}-{session_id}"[:60]
        self._start()

    def _start(self) -> None:
        cache = self._cwd / ".scout-cache"
        env = build_execution_env(home=cache / "home", cache_dir=cache)
        binary = container_engine_binary()
        image = sandbox_image()
        if not binary or not image:
            raise RuntimeError("container engine/image unavailable")
        net_args, _ = _network_args(None, ())
        cmd = [
            binary, "run", "--rm", "-i",
            "--name", self._name,
            *net_args,
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp:rw,mode=1777",
            *_limit_args(self._policy),
            *_mount_args(self._user_id),
            "-w", str(self._cwd),
            *_env_args(env),
            "--label", "scout.execution=1",
            "--label", f"scout.user={self._user_id}",
            image,
            "python", "-u", "-m", _REPL_MODULE,
        ]
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        logger.info(
            "Started container persistent session (name=%s, pid=%s, cwd=%s)",
            self._name, self._proc.pid, self._cwd,
        )
        self._inject_path_guard()

    def close(self) -> None:
        binary = container_engine_binary()
        if self._proc and self._proc.poll() is None:
            pid = self._proc.pid
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except (OSError, BrokenPipeError):
                pass
            # Stop the container directly so it cannot outlive the worker.
            if binary:
                try:
                    subprocess.run(
                        [binary, "kill", self._name],
                        capture_output=True, timeout=10,
                    )
                except (subprocess.TimeoutExpired, OSError):
                    pass
            kill_process_tree(pid)
            try:
                self._proc.wait(timeout=IO_DRAIN_TIMEOUT)
            except subprocess.TimeoutExpired:
                kill_process_tree(pid)
            logger.info("Closed container persistent session (name=%s)", self._name)
        self._proc = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _restart(self) -> None:
        logger.warning("Restarting container persistent session %s …", self._name)
        self.close()
        self._start()

    def _inject_path_guard(self) -> None:
        """Defense-in-depth open() guard inside the REPL (the container mount is
        the real boundary; this is belt-and-suspenders, identical to bwrap path)."""
        read_paths = [str(r.resolve()) for r in self._policy.read_roots]
        write_paths = [str(r.resolve()) for r in self._policy.write_roots]
        preamble = (
            "import builtins as _b, os.path as _op, sys as _s\n"
            f"_READ_ALLOWED = {read_paths!r} + [_op.realpath(p) for p in _s.path if p]\n"
            f"_WRITE_ALLOWED = {write_paths!r}\n"
            "def _path_ok(p, allowed):\n"
            "    r = _op.realpath(str(p))\n"
            "    for a in allowed:\n"
            "        if r == a or r.startswith(a + _op.sep):\n"
            "            return True\n"
            "    return False\n"
            "_orig_open = _b.open\n"
            "def _safe_open(f, m='r', *a, **k):\n"
            "    allowed = _WRITE_ALLOWED if any(x in m for x in 'wax+') else _READ_ALLOWED\n"
            "    if not _path_ok(f, allowed): raise PermissionError('Access denied: ' + str(f))\n"
            "    return _orig_open(f, m, *a, **k)\n"
            "_b.open = _safe_open\n"
        )
        output, success = self.run(preamble)
        if not success:
            logger.warning("Path guard injection failed: %s", output)

    def run(self, code: str, timeout: int | None = None) -> tuple[str, bool]:
        timeout = timeout or self._timeout
        with self._lock:
            if not self.alive:
                self._restart()

            assert self._proc is not None
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None

            try:
                self._proc.stdin.write(code)
                if not code.endswith("\n"):
                    self._proc.stdin.write("\n")
                self._proc.stdin.write(_CODE_END + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                try:
                    self.close()
                except Exception:
                    pass
                self._restart()
                return "[Session crashed — restarted]", False

            output_lines: list[str] = []

            def _reader() -> None:
                try:
                    for line in self._proc.stdout:  # type: ignore[union-attr]
                        if line.rstrip("\n") == _OUTPUT_END:
                            break
                        output_lines.append(line)
                except Exception:
                    pass

            reader_thread = threading.Thread(target=_reader, daemon=True)
            reader_thread.start()
            reader_thread.join(timeout=timeout)

            if reader_thread.is_alive():
                self._restart()
                return (
                    f"[Execution timed out after {timeout}s — session restarted]",
                    False,
                )

            output = "".join(output_lines)
            if len(output) > _MAX_OUTPUT_CHARS:
                output = (
                    output[: _MAX_OUTPUT_CHARS // 2]
                    + f"\n\n… [output truncated: {len(output)} chars total] …\n\n"
                    + output[-_MAX_OUTPUT_CHARS // 2 :]
                )
            success = "Traceback (most recent call last)" not in output
            return output.rstrip(), success

    def __enter__(self) -> "ContainerPersistentSession":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


# --------------------------------------------------------------------------- #
# One-shot container backend
# --------------------------------------------------------------------------- #
class ContainerSandboxBackend:
    """Run one-shot shell/python/node commands in throwaway sandbox containers.

    Persistent Python sessions are managed by the worker service via
    ``ContainerPersistentSession``; this backend handles the stateless paths and
    reports health.
    """

    def __init__(
        self,
        config: ExecutionConfig,
        *,
        auditor: ExecutionAuditor | None = None,
    ) -> None:
        self._config = config
        self._auditor = auditor or ExecutionAuditor()
        self._isolation, self._error = probe_container_isolation()
        # Alive Python shells, one long-lived sandbox container per user:session.
        self._sessions: dict[str, ContainerPersistentSession] = {}
        self._sessions_lock = threading.Lock()
        self._unified_exec = UnifiedExecManager(config)

    async def exec_command(self, request: UnifiedExecCommandRequest) -> UnifiedExecResponse:
        return await run_in_executor(self._unified_exec.exec_command, request)

    async def write_stdin(self, request: UnifiedExecStdinRequest) -> UnifiedExecResponse:
        return await run_in_executor(self._unified_exec.write_stdin, request)

    def set_output_chunk_callback(self, callback: OutputChunkCallback | None) -> None:
        self._unified_exec.set_chunk_callback(callback)

    async def execute(
        self, request: ExecutionRequest, *, proxy_url: str | None = None,
    ) -> ExecutionResult:
        import asyncio

        audit = self._auditor.start(
            execution_id=request.execution_id,
            user_id=request.user_id,
            session_id=request.session_id,
            runtime=request.runtime,
            command_summary=_command_summary(request),
        )

        if not self._isolation:
            self._auditor.finish(
                audit, status="failed",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )
            return ExecutionResult(
                exit_code=None, stdout="",
                stderr=self._error or "Container sandbox unavailable",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )

        persistent_python = request.persistent and request.runtime == "python"
        inner = None if persistent_python else self._inner_command(request)
        if not persistent_python and inner is None:
            return ExecutionResult(
                exit_code=None, stdout="",
                stderr=f"Unknown/unsupported runtime: {request.runtime}",
                error_category=ExecutionErrorCategory.RUNTIME_UNAVAILABLE.value,
            )

        workspace_root = request.cwd
        writable = list(request.policy.write_roots)
        if request.staging_dir:
            writable.append(request.staging_dir)
        before = snapshot_writable_roots(tuple(writable), workspace_root=workspace_root)

        loop = asyncio.get_event_loop()
        if persistent_python:
            result = await loop.run_in_executor(
                None, lambda: self._run_persistent_python(request),
            )
        else:
            assert inner is not None
            result = await loop.run_in_executor(
                None, lambda: self._run_container(request, inner, proxy_url),
            )

        after = snapshot_writable_roots(tuple(writable), workspace_root=workspace_root)
        result.changed_files = diff_snapshots(
            before, after, tuple(writable), workspace_root=workspace_root,
        )
        result.artifacts = _classify_artifacts(result.changed_files, workspace_root)

        status = "ok" if (result.exit_code == 0 or result.persistent) else "failed"
        if result.timed_out:
            status = "failed"
        self._auditor.finish(
            audit, status=status, error_category=result.error_category,
            changed_paths=[c.path for c in result.changed_files],
        )
        return result

    def _inner_command(self, request: ExecutionRequest) -> list[str] | None:
        if request.runtime == "python":
            return ["python", "-c", request.code or ""]
        if request.runtime == "shell":
            command = " ".join(request.command) if request.command else ""
            return ["/bin/sh", "-c", command]
        if request.runtime == "node":
            return ["node", "-e", request.code or ""]
        return None

    def _run_persistent_python(self, request: ExecutionRequest) -> ExecutionResult:
        key = f"{request.user_id}:{request.session_id}"
        with self._sessions_lock:
            sess = self._sessions.get(key)
            if sess is None or not sess.alive:
                sess = ContainerPersistentSession(
                    request_user_id=request.user_id,
                    session_id=request.session_id,
                    cwd=request.cwd,
                    policy=request.policy,
                    timeout=request.policy.timeout_seconds,
                )
                self._sessions[key] = sess
        output, success = sess.run(
            request.code or "", timeout=request.policy.timeout_seconds,
        )
        stderr = output if (not success and "Traceback" in output) else ""
        if stderr:
            output = ""
        return ExecutionResult(
            exit_code=0 if success else 1,
            stdout=output,
            stderr=stderr,
            persistent=True,
            error_category=None if success else ExecutionErrorCategory.COMMAND_FAILED.value,
        )

    def _run_container(
        self, request: ExecutionRequest, inner: list[str], proxy_url: str | None,
    ) -> ExecutionResult:
        args, _ = _base_run_args(request, proxy_url=proxy_url, interactive=False)
        image = sandbox_image()
        assert image
        cmd = [*args, image, *inner]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=request.policy.timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return ExecutionResult(
                exit_code=None, stdout="", stderr="Execution timed out",
                timed_out=True,
                error_category=ExecutionErrorCategory.TIMED_OUT.value,
            )
        except OSError as exc:
            return ExecutionResult(
                exit_code=None, stdout="", stderr=str(exc),
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )
        return ExecutionResult(
            exit_code=proc.returncode,
            stdout=_truncate(proc.stdout or "", request.policy.max_output_bytes),
            stderr=_truncate(proc.stderr or "", request.policy.max_output_bytes),
            error_category=(
                None if proc.returncode == 0
                else ExecutionErrorCategory.COMMAND_FAILED.value
            ),
        )

    async def close_session(self, session_id: str) -> None:
        # Reap any alive container shells for this session (one-shot containers
        # are --rm and need no cleanup).
        with self._sessions_lock:
            stale = [k for k in self._sessions if k.endswith(f":{session_id}")]
            for key in stale:
                try:
                    self._sessions[key].close()
                finally:
                    del self._sessions[key]
        await run_in_executor(self._unified_exec.close_session, session_id)

    async def health(self) -> ExecutionBackendHealth:
        return ExecutionBackendHealth(
            available=self._isolation,
            backend="container",
            isolation=self._isolation,
            error=None if self._isolation else self._error,
            persistent_python=self._isolation,
            oneshot=self._isolation,
            isolation_tier="container" if self._isolation else "disabled",
        )
