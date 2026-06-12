"""Persistent shell session inside bubblewrap (PTY when available)."""

from __future__ import annotations

import logging
import os
import pty
import select
import subprocess
import threading
from pathlib import Path

from .env import build_execution_env
from .launcher import IO_DRAIN_TIMEOUT, build_bwrap_command, kill_process_tree
from .models import ExecutionPolicy
from .runtime import enrich_execution_env, resolve_sandbox_python

logger = logging.getLogger(__name__)

_INPUT_END = "<<__END_OF_INPUT__>>"
_OUTPUT_END = "<<__END_OF_OUTPUT__>>"
_MAX_OUTPUT_CHARS = 8_000

_SHELL_LOOP = f"""#!/bin/sh
export PS1=""
while IFS= read -r __line; do
  [ "$__line" = "{_INPUT_END}" ] && continue
  eval "$__line" 2>&1
  echo "{_OUTPUT_END}"
done
"""


class PersistentShellSession:
    """Long-lived /bin/sh subprocess in bubblewrap with optional PTY."""

    def __init__(
        self,
        *,
        cwd: Path,
        policy: ExecutionPolicy,
        cache_dir: Path,
        timeout: int = 30,
        scratch_dir: Path | None = None,
        sandbox_python: str | None = None,
    ) -> None:
        self._cwd = cwd.resolve()
        self._policy = policy
        self._cache_dir = cache_dir.resolve()
        self._scratch_dir = (scratch_dir or cache_dir / "shell-scratch").resolve()
        self._scratch_dir.mkdir(parents=True, exist_ok=True)
        self._timeout = timeout
        self._sandbox_python = resolve_sandbox_python(sandbox_python)
        self._master_fd: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.RLock()
        self._start()

    def _build_env(self) -> dict[str, str]:
        exec_home = self._cache_dir / "home"
        exec_home.mkdir(parents=True, exist_ok=True)
        env = build_execution_env(home=exec_home, cache_dir=self._cache_dir)
        env["TERM"] = "xterm-256color"
        return enrich_execution_env(env, sandbox_python=self._sandbox_python, cache_dir=self._cache_dir)

    def _start(self) -> None:
        loop_path = self._scratch_dir / "shell_loop.sh"
        loop_path.write_text(_SHELL_LOOP, encoding="utf-8")
        loop_path.chmod(0o755)

        env = self._build_env()
        cmd = build_bwrap_command(
            ["/bin/sh", str(loop_path)],
            cwd=self._cwd,
            env=env,
            policy=self._policy,
            private_tmp=self._scratch_dir / "tmp",
            python_binary=self._sandbox_python,
            workspace_root=self._cwd,
        )

        master, slave = pty.openpty()
        self._master_fd = master
        self._proc = subprocess.Popen(
            cmd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        logger.info("Started persistent shell session (pid=%s, cwd=%s)", self._proc.pid, self._cwd)

    def close(self) -> None:
        if self._proc and self._proc.poll() is None:
            pid = self._proc.pid
            kill_process_tree(pid)
            try:
                self._proc.wait(timeout=IO_DRAIN_TIMEOUT)
            except subprocess.TimeoutExpired:
                kill_process_tree(pid)
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
        self._master_fd = None
        self._proc = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _restart(self) -> None:
        self.close()
        self._start()

    def run(self, command: str, timeout: int | None = None) -> tuple[str, bool]:
        timeout = timeout or self._timeout
        with self._lock:
            if not self.alive or self._master_fd is None:
                self._restart()

            assert self._master_fd is not None
            payload = (command.strip() + "\n" + _INPUT_END + "\n").encode("utf-8")
            try:
                os.write(self._master_fd, payload)
            except OSError:
                self._restart()
                return "[Shell session crashed — restarted]", False

            output_chunks: list[bytes] = []
            deadline = timeout

            while True:
                ready, _, _ = select.select([self._master_fd], [], [], deadline)
                if not ready:
                    kill_process_tree(self._proc.pid)  # type: ignore[union-attr]
                    self._restart()
                    return f"[Shell timed out after {timeout}s — session restarted]", False
                chunk = os.read(self._master_fd, 4096)
                if not chunk:
                    break
                output_chunks.append(chunk)
                if _OUTPUT_END.encode() in b"".join(output_chunks):
                    break

            raw = b"".join(output_chunks).decode("utf-8", errors="replace")
            if _OUTPUT_END in raw:
                raw = raw.split(_OUTPUT_END)[0]
            output = raw.strip()
            if len(output) > _MAX_OUTPUT_CHARS:
                output = output[:_MAX_OUTPUT_CHARS] + "\n… [truncated]"
            return output, True

    def __enter__(self) -> "PersistentShellSession":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class PersistentShellManager:
    """One persistent shell per Scout session (staging cwd)."""

    def __init__(self, *, timeout: int) -> None:
        self._timeout = timeout
        self._sessions: dict[str, PersistentShellSession] = {}
        self._lock = threading.RLock()

    def _session_key(self, user_id: str, session_id: str) -> str:
        return f"{user_id}:{session_id}"

    def get_or_create(
        self,
        user_id: str,
        session_id: str,
        cwd: Path,
        policy: ExecutionPolicy,
        cache_dir: Path,
        scratch_dir: Path | None = None,
    ) -> PersistentShellSession:
        key = self._session_key(user_id, session_id)
        with self._lock:
            if key in self._sessions and self._sessions[key].alive:
                return self._sessions[key]
            session = PersistentShellSession(
                cwd=cwd,
                policy=policy,
                cache_dir=cache_dir,
                timeout=self._timeout,
                scratch_dir=scratch_dir,
            )
            self._sessions[key] = session
            return session

    def close_session(self, session_id: str) -> None:
        with self._lock:
            to_remove = [k for k in self._sessions if k.endswith(f":{session_id}")]
            for key in to_remove:
                self._sessions[key].close()
                del self._sessions[key]

    def close_all(self) -> None:
        with self._lock:
            for session in self._sessions.values():
                session.close()
            self._sessions.clear()
