"""OS-level sandbox launcher using bubblewrap when available."""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

from .models import ExecutionPolicy
from .network_setup import (
    IsolatedNetwork,
    IsolatedNetworkManager,
    network_isolation_available,
    wrap_command_in_netns,
)
from .policy import safe_read_bind_paths

logger = logging.getLogger(__name__)

_BWRAP = shutil.which("bwrap")
IO_DRAIN_TIMEOUT = 3
# Leave room for envp passed to execve alongside argv.
_ARGV_ENV_HEADROOM = 65536


def bwrap_available() -> bool:
    return _BWRAP is not None


def bwrap_path() -> str | None:
    return _BWRAP


def _runtime_bind_args() -> list[str]:
    """Read-only binds for runtime libraries."""
    args: list[str] = []
    for path in ("/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc/resolv.conf", "/etc/ssl", "/etc/nsswitch.conf"):
        p = Path(path)
        if p.exists():
            args.extend(["--ro-bind", str(p), str(p)])
    return args


def _python_prefix(python: str | None = None) -> Path | None:
    import sys
    py = python or sys.executable
    try:
        r = subprocess.run(
            [py, "-c", "import sys; print(sys.prefix)"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            prefix = Path(r.stdout.strip())
            if prefix.is_dir():
                return prefix
    except Exception:
        pass
    return Path(py).resolve().parent.parent if py else None


def _arg_max() -> int:
    try:
        return int(os.sysconf("SC_ARG_MAX"))
    except (AttributeError, OSError, ValueError):
        return 2 * 1024 * 1024


def _estimate_argv_bytes(args: list[str]) -> int:
    return sum(len(arg) + 1 for arg in args)


def _check_bwrap_argv_limit(args: list[str]) -> None:
    """Fail fast with a clear error before execve hits E2BIG."""
    limit = _arg_max() - _ARGV_ENV_HEADROOM
    size = _estimate_argv_bytes(args)
    if size > limit:
        raise RuntimeError(
            "Sandbox command line too large for bubblewrap "
            f"({size} bytes estimated, limit ~{limit} bytes). "
            "The workspace may contain too many bind mounts — try multi-user mode, "
            "a smaller workspace directory, or container-based isolation."
        )


def build_bwrap_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    policy: ExecutionPolicy,
    private_tmp: Path | None = None,
    python_binary: str | None = None,
    proxy_url: str | None = None,
    isolated_network: bool = False,
    workspace_root: Path | None = None,
) -> list[str]:
    """Build a bubblewrap command line for isolated execution."""
    if not _BWRAP:
        raise RuntimeError("bubblewrap (bwrap) not found")

    tmp = private_tmp or Path(tempfile.mkdtemp(prefix="scout-exec-"))
    tmp.mkdir(parents=True, exist_ok=True)

    use_network_proxy = policy.network.mode == "allow_domains" and proxy_url
    if use_network_proxy and not isolated_network:
        raise RuntimeError("Network access requires an isolated network namespace")

    unshare_args = (
        ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup"]
        if use_network_proxy
        else ["--unshare-all"]
    )
    args = [
        _BWRAP,
        *unshare_args,
        "--die-with-parent",
        "--new-session",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--bind", str(tmp), str(tmp),
    ]
    args.extend(_runtime_bind_args())

    seen: set[str] = set()
    prefix = _python_prefix(python_binary or (command[0] if command else None))
    if prefix and prefix.is_dir():
        args.extend(["--ro-bind", str(prefix), str(prefix)])
        seen.add(str(prefix))

    ws_root = workspace_root or cwd
    for root in policy.read_roots:
        bind_paths = safe_read_bind_paths(root, ws_root, policy.denied_roots)
        for bind_path in bind_paths:
            r = str(bind_path.resolve())
            if r in seen or not Path(r).exists():
                continue
            seen.add(r)
            mode = "bind" if bind_path in policy.write_roots else "ro-bind"
            args.extend([f"--{mode}", r, r])

    for root in policy.write_roots:
        if any(str(root.resolve()).startswith(str(d.resolve())) for d in policy.denied_roots):
            continue
        r = str(root.resolve())
        if r in seen:
            continue
        seen.add(r)
        Path(r).mkdir(parents=True, exist_ok=True)
        args.extend(["--bind", r, r])

    args.extend(["--chdir", str(cwd.resolve())])

    exec_env = dict(env)
    if use_network_proxy and proxy_url:
        exec_env["HTTP_PROXY"] = proxy_url
        exec_env["HTTPS_PROXY"] = proxy_url
        exec_env["http_proxy"] = proxy_url
        exec_env["https_proxy"] = proxy_url
        exec_env["NO_PROXY"] = "localhost,127.0.0.1"
        exec_env["no_proxy"] = "localhost,127.0.0.1"

    for key, val in exec_env.items():
        args.extend(["--setenv", key, val])

    inner = list(command)
    if policy.max_memory_bytes or policy.max_processes or policy.cpu_seconds:
        inner = [
            "sh", "-c",
            (
                "ulimit -v {mem} 2>/dev/null; "
                "ulimit -u {proc} 2>/dev/null; "
                "ulimit -t {cpu} 2>/dev/null; "
                "exec \"$@\""
            ).format(
                mem=(policy.max_memory_bytes or 0) // 1024 or 0,
                proc=policy.max_processes or 0,
                cpu=policy.cpu_seconds or 0,
            ),
            "scout-limit",
            *command,
        ]

    args.append("--")
    args.extend(inner)
    _check_bwrap_argv_limit(args)
    return args


def kill_process_tree(pid: int) -> None:
    """Best-effort kill of a process and its descendants."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def drain_process_io(proc: subprocess.Popen, *, timeout: float = IO_DRAIN_TIMEOUT) -> None:
    """Wait for process exit and drain pipes after kill."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        time.sleep(0.05)
    try:
        if proc.stdout:
            proc.stdout.read()
        if proc.stderr and proc.stderr is not proc.stdout:
            proc.stderr.read()
    except Exception:
        pass


def run_sandboxed(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    policy: ExecutionPolicy,
    timeout: int,
    private_tmp: Path | None = None,
    proxy_url: str | None = None,
    workspace_root: Path | None = None,
    sandbox_python: str | None = None,
) -> subprocess.CompletedProcess:
    """Run *command* inside bubblewrap or raise if unavailable."""
    net: IsolatedNetwork | None = None
    net_mgr: IsolatedNetworkManager | None = None
    effective_proxy = proxy_url

    if policy.network.mode == "allow_domains" and proxy_url:
        if not network_isolation_available():
            raise RuntimeError(
                "Network egress requires CAP_NET_ADMIN for isolated network namespaces"
            )
        net_mgr = IsolatedNetworkManager(proxy_url)
        net = net_mgr.create()
        effective_proxy = net.proxy_url

    try:
        bwrap_cmd = build_bwrap_command(
            command, cwd=cwd, env=env, policy=policy, private_tmp=private_tmp,
            python_binary=sandbox_python or (command[0] if command else None),
            proxy_url=effective_proxy,
            isolated_network=net is not None,
            workspace_root=workspace_root or cwd,
        )
        launch_cmd = wrap_command_in_netns(bwrap_cmd, net) if net else bwrap_cmd

        proc = subprocess.Popen(
            launch_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(cwd),
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            return subprocess.CompletedProcess(launch_cmd, proc.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            kill_process_tree(proc.pid)
            drain_process_io(proc)
            raise
    finally:
        if net and net_mgr:
            net_mgr.destroy(net)
