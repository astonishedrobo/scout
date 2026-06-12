"""Persistent Python session managed through the execution backend."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from .launcher import bwrap_available
from .persistent_readiness import probe_python_readiness
from .persistent_sandbox import PersistentSandboxSession
from .runtime import resolve_sandbox_python
from .sandbox_probe import probe_sandbox_isolation

if TYPE_CHECKING:
    from .models import ExecutionPolicy

logger = logging.getLogger(__name__)


class PersistentPythonManager:
    """One persistent Python worker per Scout session."""

    def __init__(
        self,
        *,
        conda_env: str,
        python_path: str | None,
        timeout: int,
        allow_insecure: bool,
    ) -> None:
        self._conda_env = conda_env
        self._python_path = python_path
        self._timeout = timeout
        self._allow_insecure = allow_insecure
        self._sessions: dict[str, PersistentSandboxSession] = {}
        self._session_keys: dict[str, tuple[str, str]] = {}
        self._lock = threading.RLock()
        self._readiness_errors: dict[str, str] = {}
        self._probe = probe_sandbox_isolation()

    @property
    def isolation_available(self) -> bool:
        if self._probe.isolation and self._probe.persistent_python:
            return True
        return self._allow_insecure and not self._probe.isolation

    def _session_key(self, user_id: str, session_id: str) -> str:
        return f"{user_id}:{session_id}"

    def _resolve_python(self) -> str:
        return resolve_sandbox_python(self._python_path)

    @property
    def sandbox_python(self) -> str:
        return self._resolve_python()

    def get_or_create(
        self,
        user_id: str,
        session_id: str,
        cwd: Path,
        policy: "ExecutionPolicy",
        cache_dir: Path,
        scratch_dir: Path | None = None,
    ) -> PersistentSandboxSession | None:
        key = self._session_key(user_id, session_id)
        with self._lock:
            if key in self._sessions and self._sessions[key].alive:
                return self._sessions[key]

            if not self.isolation_available:
                return None

            session = PersistentSandboxSession(
                python_binary=self._resolve_python(),
                cwd=cwd,
                policy=policy,
                cache_dir=cache_dir,
                timeout=self._timeout,
                scratch_dir=scratch_dir,
            )
            ready, err = probe_python_readiness(session)
            if not ready:
                self._readiness_errors[key] = err or "Python worker readiness check failed"
                session.close()
                return None

            self._sessions[key] = session
            self._session_keys[key] = (user_id, str(cwd))
            self._readiness_errors.pop(key, None)
            return session

    def close_session(self, session_id: str) -> None:
        with self._lock:
            to_remove = [k for k in self._sessions if k.endswith(f":{session_id}")]
            for key in to_remove:
                self._sessions[key].close()
                del self._sessions[key]
                self._session_keys.pop(key, None)
                self._readiness_errors.pop(key, None)

    def close_all(self) -> None:
        with self._lock:
            for session in self._sessions.values():
                session.close()
            self._sessions.clear()
            self._session_keys.clear()
            self._readiness_errors.clear()
