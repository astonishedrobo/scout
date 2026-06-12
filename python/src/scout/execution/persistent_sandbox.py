"""Bubblewrap-wrapped persistent Python REPL session."""

from __future__ import annotations

import logging
import subprocess
import threading
from pathlib import Path

from .env import build_execution_env
from .launcher import IO_DRAIN_TIMEOUT, build_bwrap_command, kill_process_tree
from .runtime import enrich_execution_env
from .models import ExecutionPolicy

logger = logging.getLogger(__name__)

_CODE_END = "<<__END_OF_CODE__>>"
_OUTPUT_END = "<<__END_OF_OUTPUT__>>"
_MAX_OUTPUT_CHARS = 4_000

_REPL_SCRIPT = str(Path(__file__).resolve().parent.parent / "agent" / "_repl_server.py")


class PersistentSandboxSession:
    """Long-lived REPL subprocess launched inside bubblewrap."""

    def __init__(
        self,
        *,
        python_binary: str,
        cwd: Path,
        policy: ExecutionPolicy,
        cache_dir: Path,
        timeout: int = 30,
        scratch_dir: Path | None = None,
    ) -> None:
        self._python = python_binary
        self._cwd = cwd.resolve()
        self._policy = policy
        self._cache_dir = cache_dir.resolve()
        self._scratch_dir = (scratch_dir or cache_dir / "session-scratch").resolve()
        self._scratch_dir.mkdir(parents=True, exist_ok=True)
        self._timeout = timeout
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.RLock()
        self._start()

    def _build_env(self) -> dict[str, str]:
        exec_home = self._cache_dir / "home"
        exec_home.mkdir(parents=True, exist_ok=True)
        env = build_execution_env(home=exec_home, cache_dir=self._cache_dir)
        return enrich_execution_env(env, sandbox_python=self._python, cache_dir=self._cache_dir)

    def _start(self) -> None:
        env = self._build_env()
        cmd = build_bwrap_command(
            [self._python, "-u", _REPL_SCRIPT],
            cwd=self._cwd,
            env=env,
            policy=self._policy,
            python_binary=self._python,
            private_tmp=self._scratch_dir / "tmp",
            workspace_root=self._cwd,
        )
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
            "Started bwrap-wrapped persistent session (pid=%s, cwd=%s)",
            self._proc.pid,
            self._cwd,
        )
        self._inject_path_guard()

    def close(self) -> None:
        if self._proc and self._proc.poll() is None:
            pid = self._proc.pid
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except (OSError, BrokenPipeError):
                pass
            kill_process_tree(pid)
            try:
                self._proc.wait(timeout=IO_DRAIN_TIMEOUT)
            except subprocess.TimeoutExpired:
                kill_process_tree(pid)
            logger.info("Closed persistent sandbox session (pid=%s)", pid)
        self._proc = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _restart(self) -> None:
        logger.warning("Restarting persistent sandbox session …")
        self.close()
        self._start()

    def _inject_path_guard(self) -> None:
        """Defense-in-depth path guard inside the REPL."""
        read_paths = [str(r.resolve()) for r in self._policy.read_roots]
        write_paths = [str(r.resolve()) for r in self._policy.write_roots]
        preamble = (
            "import builtins as _b, os as _o, os.path as _op, sys as _s\n"
            f"_READ_ALLOWED = {read_paths!r} + [_op.realpath(p) for p in _s.path if p]\n"
            f"_WRITE_ALLOWED = {write_paths!r}\n"
            "def _path_ok(p, allowed):\n"
            "    import os.path as _op2\n"
            "    r = _op.realpath(str(p))\n"
            "    for a in allowed:\n"
            "        try:\n"
            "            _op2.relpath(r, a)\n"
            "            if r == a or r.startswith(a + _op.sep):\n"
            "                return True\n"
            "        except ValueError:\n"
            "            continue\n"
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
                        stripped = line.rstrip("\n")
                        if stripped == _OUTPUT_END:
                            break
                        output_lines.append(line)
                except Exception:
                    pass

            reader_thread = threading.Thread(target=_reader, daemon=True)
            reader_thread.start()
            reader_thread.join(timeout=timeout)

            if reader_thread.is_alive():
                kill_process_tree(self._proc.pid)
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

    def __enter__(self) -> "PersistentSandboxSession":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
