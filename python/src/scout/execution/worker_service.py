"""Isolated execution worker microservice (internal RPC)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import ExecutionConfig
from .container_backend import (
    ContainerPersistentSession,
    ContainerSandboxBackend,
    probe_container_isolation,
)
from .env import build_execution_env
from .local_backend import LocalSandboxBackend
from .models import ExecutionPolicy, ExecutionRequest, NetworkPolicy
from .persistent_sandbox import PersistentSandboxSession
from .policy import build_execution_policy, build_execution_environment
from .runtime import resolve_sandbox_python
from .sandbox_probe import probe_sandbox_isolation
from .worker_auth import verify_bearer, verify_signed_request
from .worker_roots import derive_user_roots, validate_user_id

logger = logging.getLogger(__name__)

_MAX_ACTIVE_SESSIONS_PER_USER = 3
_SESSION_IDLE_SECONDS = 3600


class ExecutePayload(BaseModel):
    execution_id: str
    user_id: str
    session_id: str
    runtime: str
    command: list[str] | None = None
    code: str | None = None
    persistent: bool = False
    staging_dir: str | None = None
    grant_ids: list[str] = Field(default_factory=list)
    network_domains: list[str] = Field(default_factory=list)
    sandbox_python: str | None = None
    personal_write: bool = False


class SessionStartPayload(BaseModel):
    user_id: str
    session_id: str
    grant_ids: list[str] = Field(default_factory=list)
    sandbox_python: str | None = None


class SessionWritePayload(BaseModel):
    user_id: str
    session_id: str
    code: str
    timeout_seconds: int | None = None


class SessionClosePayload(BaseModel):
    user_id: str
    session_id: str


class ExecCommandPayload(BaseModel):
    execution_id: str
    user_id: str
    session_id: str
    command: str
    cwd: str
    staging_dir: str | None = None
    work_dir: str | None = None
    yield_time_ms: int = 10_000
    max_output_tokens: int = 10_000
    tty: bool = True
    tool_call_id: str = ""
    network_domains: list[str] = Field(default_factory=list)
    sandbox_python: str | None = None
    personal_write: bool = False


class ExecStdinPayload(BaseModel):
    user_id: str
    session_id: str
    process_id: int
    chars: str = ""
    yield_time_ms: int = 10_000
    max_output_tokens: int = 10_000
    tool_call_id: str = ""


class _ManagedSession:
    def __init__(self, session: PersistentSandboxSession, user_id: str, session_id: str) -> None:
        self.session = session
        self.user_id = user_id
        self.session_id = session_id
        self.last_used = time.time()
        self.write_lock = threading.Lock()


def create_worker_app(config: ExecutionConfig | None = None) -> FastAPI:
    cfg = config or ExecutionConfig()
    proxy_url = os.environ.get("SCOUT_EGRESS_PROXY_URL", "http://egress-proxy:7892")
    worker_sandbox_python = resolve_sandbox_python(os.environ.get("SCOUT_AGENT_PYTHON"))

    # --- Pick the strongest available isolation tier ---------------------- #
    # 'container' (per-session sandbox container) is portable to any Docker host
    # without unprivileged user namespaces; 'bwrap' is the legacy in-worker path.
    bwrap_probe = probe_sandbox_isolation()
    use_container = False
    container_error: str | None = None
    if cfg.isolation in ("auto", "container"):
        use_container, container_error = probe_container_isolation()

    if use_container:
        backend = ContainerSandboxBackend(cfg)
        isolation_tier = "container"
        isolation_ok = True
        persistent_ok = True
        oneshot_ok = True
        isolation_error: str | None = None
    else:
        backend = LocalSandboxBackend(
            cfg,
            python_path=os.environ.get("SCOUT_AGENT_PYTHON"),
        )
        isolation_ok = bwrap_probe.isolation
        isolation_tier = "bwrap" if bwrap_probe.isolation else "disabled"
        persistent_ok = bwrap_probe.persistent_python
        oneshot_ok = bwrap_probe.oneshot
        isolation_error = bwrap_probe.error
        if cfg.isolation == "container" and container_error:
            # Container explicitly requested but unavailable — fail closed and
            # surface why (do not silently degrade to bwrap on an untrusted host).
            isolation_ok = False
            isolation_tier = "disabled"
            isolation_error = container_error

    managed_sessions: dict[str, _ManagedSession] = {}
    sessions_lock = threading.RLock()

    app = FastAPI(title="Scout Execution Worker", version="0.2.0")

    @app.on_event("shutdown")
    async def _cleanup_sessions() -> None:
        with sessions_lock:
            for ms in managed_sessions.values():
                ms.session.close()
            managed_sessions.clear()

    def _session_key(user_id: str, session_id: str) -> str:
        return f"{user_id}:{session_id}"

    def _build_policy(
        user_id: str,
        session_id: str,
        *,
        staging_dir: Path | None,
        persistent: bool,
        domains: list[str],
        personal_write: bool = False,
    ):
        layout = derive_user_roots(user_id)
        personal = layout.personal_root
        shared = layout.shared_root
        scratch = personal / ".scout-cache" / "session-scratch" / session_id if persistent else None
        return build_execution_policy(
            personal_dir=personal,
            shared_dir=shared,
            config=cfg,
            network_domains=tuple(domains),
            staging_dir=staging_dir,
            scratch_dir=scratch if persistent else None,
            persistent=persistent,
            personal_write=personal_write,
        )

    def _auth_request(
        request: Request,
        authorization: str | None,
        body: bytes,
        user_id: str | None = None,
    ) -> None:
        verify_bearer(authorization)
        verify_signed_request(
            authorization=authorization,
            body=body,
            signature=request.headers.get("X-Scout-Signature"),
            timestamp=request.headers.get("X-Scout-Timestamp"),
            nonce=request.headers.get("X-Scout-Nonce"),
            payload_user_id=user_id,
        )

    @app.get("/health")
    async def health(authorization: str | None = Header(None)):
        verify_bearer(authorization)
        h = await backend.health()
        with sessions_lock:
            active = len(managed_sessions)
        return {
            "status": "ok" if h.available and isolation_ok else "error",
            "backend": h.backend,
            "isolation": isolation_ok,
            "isolation_tier": isolation_tier,
            "persistent_python": persistent_ok,
            "oneshot": oneshot_ok,
            "worker_reachable": True,
            "active_sessions": active,
            "warnings": h.warnings,
            "error": h.error or isolation_error,
        }

    @app.post("/execute")
    async def execute(
        request: Request,
        authorization: str | None = Header(None),
    ):
        body = await request.body()
        payload = ExecutePayload.model_validate_json(body)
        _auth_request(request, authorization, body, payload.user_id)
        validate_user_id(payload.user_id)
        layout = derive_user_roots(payload.user_id)
        staging_path = Path(payload.staging_dir) if payload.staging_dir else None
        policy = _build_policy(
            payload.user_id,
            payload.session_id,
            staging_dir=staging_path / "work" if staging_path else None,
            persistent=payload.persistent,
            domains=payload.network_domains,
            personal_write=payload.personal_write,
        )
        cache = layout.personal_root / ".scout-cache"
        sandbox_python = resolve_sandbox_python(payload.sandbox_python or worker_sandbox_python)
        env = build_execution_environment(
            layout.personal_root,
            sandbox_python=sandbox_python,
        )
        scratch = layout.personal_root / ".scout-cache" / "session-scratch" / payload.session_id

        req = ExecutionRequest(
            execution_id=payload.execution_id,
            user_id=payload.user_id,
            session_id=payload.session_id,
            runtime=payload.runtime,  # type: ignore[arg-type]
            command=tuple(payload.command) if payload.command else None,
            code=payload.code,
            cwd=layout.personal_root,
            policy=policy,
            environment=env,
            persistent=payload.persistent,
            staging_dir=staging_path,
            scratch_dir=scratch if payload.persistent else None,
            sandbox_python=sandbox_python,
        )
        effective_proxy = proxy_url if payload.network_domains else None
        result = await backend.execute(req, proxy_url=effective_proxy)
        return {
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "timed_out": result.timed_out,
            "error_category": result.error_category,
            "changed_files": [
                {"path": c.path, "status": c.status, "old_hash": c.old_hash, "new_hash": c.new_hash}
                for c in result.changed_files
            ],
            "artifacts": result.artifacts,
        }

    @app.post("/session/start")
    async def session_start(
        request: Request,
        authorization: str | None = Header(None),
    ):
        body = await request.body()
        payload = SessionStartPayload.model_validate_json(body)
        _auth_request(request, authorization, body, payload.user_id)
        validate_user_id(payload.user_id)
        layout = derive_user_roots(payload.user_id)
        key = _session_key(payload.user_id, payload.session_id)

        with sessions_lock:
            if key in managed_sessions:
                if managed_sessions[key].user_id != payload.user_id:
                    raise HTTPException(status_code=403, detail="Session ownership mismatch")
                return {"status": "ok", "message": "already_started"}

            user_sessions = [k for k in managed_sessions if k.startswith(f"{payload.user_id}:")]
            if len(user_sessions) >= _MAX_ACTIVE_SESSIONS_PER_USER:
                raise HTTPException(status_code=429, detail="Too many active sessions")

            policy = _build_policy(
                payload.user_id, payload.session_id,
                staging_dir=None, persistent=True, domains=[],
            )
            cache = layout.personal_root / ".scout-cache"
            if use_container:
                session: PersistentSandboxSession | ContainerPersistentSession = (
                    ContainerPersistentSession(
                        request_user_id=payload.user_id,
                        session_id=payload.session_id,
                        cwd=layout.personal_root,
                        policy=policy,
                        timeout=cfg.timeout_seconds,
                    )
                )
            else:
                scratch = cache / "session-scratch" / payload.session_id
                session_python = resolve_sandbox_python(
                    payload.sandbox_python or worker_sandbox_python,
                )
                session = PersistentSandboxSession(
                    python_binary=session_python,
                    cwd=layout.personal_root,
                    policy=policy,
                    cache_dir=cache,
                    timeout=cfg.timeout_seconds,
                    scratch_dir=scratch,
                )
            managed_sessions[key] = _ManagedSession(session, payload.user_id, payload.session_id)

        return {"status": "ok"}

    @app.post("/session/write")
    async def session_write(
        request: Request,
        authorization: str | None = Header(None),
    ):
        body = await request.body()
        payload = SessionWritePayload.model_validate_json(body)
        _auth_request(request, authorization, body, payload.user_id)
        key = _session_key(payload.user_id, payload.session_id)

        with sessions_lock:
            ms = managed_sessions.get(key)
            if ms is None:
                raise HTTPException(status_code=404, detail="Session not found")
            if ms.user_id != payload.user_id:
                raise HTTPException(status_code=403, detail="Session ownership mismatch")

        loop = asyncio.get_event_loop()
        timeout = payload.timeout_seconds or cfg.timeout_seconds

        def _run():
            with ms.write_lock:
                ms.last_used = time.time()
                return ms.session.run(payload.code, timeout=timeout)

        output, success = await loop.run_in_executor(None, _run)
        stderr = output if not success and "Traceback" in output else ""
        if stderr:
            output = ""
        return {
            "stdout": output,
            "stderr": stderr,
            "success": success,
            "persistent": True,
            "exit_code": 0 if success else 1,
        }

    @app.post("/session/close")
    async def session_close(
        request: Request,
        authorization: str | None = Header(None),
    ):
        body = await request.body()
        payload = SessionClosePayload.model_validate_json(body)
        _auth_request(request, authorization, body, payload.user_id)
        key = _session_key(payload.user_id, payload.session_id)

        with sessions_lock:
            ms = managed_sessions.pop(key, None)
        if ms:
            ms.session.close()
        return {"status": "ok"}

    def _unified_mgr():
        return getattr(backend, "_unified_exec", None)

    def _map_rpc_workspace_path(path: str | None, layout) -> Path | None:
        """Map server-visible /app/workspace paths to worker-visible roots."""
        if not path:
            return None
        p = Path(path)
        parts = p.parts
        try:
            workspace_idx = parts.index("workspace")
        except ValueError:
            return p

        rel = Path(*parts[workspace_idx + 1:])
        if rel.parts[:2] == ("users", layout.personal_root.name):
            tail = rel.parts[2:]
            return layout.personal_root / (Path(*tail) if tail else Path("."))
        if rel.parts[:1] == ("shared",):
            tail = rel.parts[1:]
            return layout.shared_root / (Path(*tail) if tail else Path("."))
        return p

    @app.post("/exec/command")
    async def exec_command(
        request: Request,
        authorization: str | None = Header(None),
    ):
        from .unified_exec import UnifiedExecCommandRequest

        body = await request.body()
        payload = ExecCommandPayload.model_validate_json(body)
        _auth_request(request, authorization, body, payload.user_id)
        validate_user_id(payload.user_id)
        layout = derive_user_roots(payload.user_id)
        staging_path = _map_rpc_workspace_path(payload.staging_dir, layout)
        cwd = _map_rpc_workspace_path(payload.cwd, layout) or layout.personal_root
        policy = _build_policy(
            payload.user_id,
            payload.session_id,
            staging_dir=None,
            persistent=False,
            domains=payload.network_domains,
            personal_write=payload.personal_write,
        )
        mgr = _unified_mgr()
        if mgr is None:
            raise HTTPException(status_code=503, detail="Unified exec unavailable")
        mgr.register_stream(payload.execution_id)
        try:
            exec_python = resolve_sandbox_python(payload.sandbox_python or worker_sandbox_python)
            req = UnifiedExecCommandRequest(
                execution_id=payload.execution_id,
                user_id=payload.user_id,
                session_id=payload.session_id,
                command=payload.command,
                cwd=cwd,
                policy=policy,
                staging_dir=staging_path,
                work_dir=_map_rpc_workspace_path(payload.work_dir, layout),
                yield_time_ms=payload.yield_time_ms,
                max_output_tokens=payload.max_output_tokens,
                tty=payload.tty,
                tool_call_id=payload.tool_call_id,
                proxy_url=proxy_url if payload.network_domains else None,
                allow_insecure_fallback=cfg.allow_insecure_local_fallback,
                sandbox_python=exec_python,
            )
            loop = asyncio.get_event_loop()
            resp = await loop.run_in_executor(None, mgr.exec_command, req)
        finally:
            pass
        return {
            "output": resp.output,
            "wall_time_seconds": resp.wall_time_seconds,
            "process_id": resp.process_id,
            "exit_code": resp.exit_code,
            "chunk_id": resp.chunk_id,
            "error": resp.error,
            "alive": resp.alive,
            "changed_files": [
                {"path": c.path, "status": c.status, "old_hash": c.old_hash, "new_hash": c.new_hash}
                for c in resp.changed_files
            ],
            "artifacts": resp.artifacts,
        }

    @app.post("/exec/stdin")
    async def exec_stdin(
        request: Request,
        authorization: str | None = Header(None),
    ):
        from .unified_exec import UnifiedExecStdinRequest

        body = await request.body()
        payload = ExecStdinPayload.model_validate_json(body)
        _auth_request(request, authorization, body, payload.user_id)
        mgr = _unified_mgr()
        if mgr is None:
            raise HTTPException(status_code=503, detail="Unified exec unavailable")
        req = UnifiedExecStdinRequest(
            user_id=payload.user_id,
            session_id=payload.session_id,
            process_id=payload.process_id,
            chars=payload.chars,
            yield_time_ms=payload.yield_time_ms,
            max_output_tokens=payload.max_output_tokens,
            tool_call_id=payload.tool_call_id,
        )
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(None, mgr.write_stdin, req)
        return {
            "output": resp.output,
            "wall_time_seconds": resp.wall_time_seconds,
            "process_id": resp.process_id,
            "exit_code": resp.exit_code,
            "chunk_id": resp.chunk_id,
            "error": resp.error,
            "alive": resp.alive,
            "changed_files": [
                {"path": c.path, "status": c.status, "old_hash": c.old_hash, "new_hash": c.new_hash}
                for c in resp.changed_files
            ],
            "artifacts": resp.artifacts,
        }

    @app.get("/exec/stream/{execution_id}")
    async def exec_stream(
        execution_id: str,
        authorization: str | None = Header(None),
    ):
        verify_bearer(authorization)
        mgr = _unified_mgr()
        if mgr is None:
            raise HTTPException(status_code=503, detail="Unified exec unavailable")

        def _generate():
            import json
            for chunk in mgr.iter_stream(execution_id, timeout=0.3):
                yield json.dumps({"chunk": chunk}) + "\n"
            mgr.unregister_stream(execution_id)

        return StreamingResponse(_generate(), media_type="application/x-ndjson")

    @app.post("/close-session")
    async def close_session(
        request: Request,
        authorization: str | None = Header(None),
    ):
        body = await request.body()
        data = __import__("json").loads(body or b"{}")
        session_id = data.get("session_id", "")
        with sessions_lock:
            to_remove = [k for k in managed_sessions if k.endswith(f":{session_id}")]
            for key in to_remove:
                managed_sessions[key].session.close()
                del managed_sessions[key]
        await backend.close_session(session_id)
        return {"status": "ok"}

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Scout Execution Worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7891)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(level=getattr(logging, args.log_level))

    import uvicorn

    app = create_worker_app()
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level.lower())


if __name__ == "__main__":
    main()
