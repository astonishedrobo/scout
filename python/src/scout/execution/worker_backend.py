"""Worker-container execution backend for server mode."""

from __future__ import annotations

import asyncio
import json
import logging

import httpx

from ..config import ExecutionConfig
from .audit import ExecutionAuditor
from .errors import ExecutionErrorCategory
from .models import ExecutionBackendHealth, ExecutionFileChange, ExecutionRequest, ExecutionResult
from .unified_exec import (
    OutputChunkCallback,
    UnifiedExecCommandRequest,
    UnifiedExecResponse,
    UnifiedExecStdinRequest,
)
from .worker_auth import require_worker_secret, sign_request_body

logger = logging.getLogger(__name__)


class WorkerExecutionBackend:
    """Execute commands via an isolated execution-worker service."""

    def __init__(
        self,
        config: ExecutionConfig,
        *,
        worker_url: str | None = None,
        auditor: ExecutionAuditor | None = None,
    ) -> None:
        self._config = config
        self._worker_url = (worker_url or config.worker_url).rstrip("/")
        self._auditor = auditor or ExecutionAuditor()
        self._secret = require_worker_secret()
        self._client = httpx.AsyncClient(timeout=config.timeout_seconds + 30)
        self._on_chunk: OutputChunkCallback | None = None

    def _headers(self, body: dict) -> dict[str, str]:
        signed = sign_request_body(body, secret=self._secret)
        return {
            "Authorization": f"Bearer {self._secret}",
            "Content-Type": "application/json",
            **signed,
        }

    async def execute(
        self, request: ExecutionRequest, *, proxy_url: str | None = None,
    ) -> ExecutionResult:
        audit = self._auditor.start(
            execution_id=request.execution_id,
            user_id=request.user_id,
            session_id=request.session_id,
            runtime=request.runtime,
            command_summary=_command_summary(request),
        )

        health = await self.health()
        if not health.available:
            self._auditor.finish(
                audit, status="failed",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )
            return ExecutionResult(
                exit_code=None,
                stdout="",
                stderr=health.error or "Execution worker unavailable",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )

        domains = list(request.policy.network.domains)
        payload = {
            "execution_id": request.execution_id,
            "user_id": request.user_id,
            "session_id": request.session_id,
            "runtime": request.runtime,
            "command": list(request.command) if request.command else None,
            "code": request.code,
            "persistent": request.persistent,
            "staging_dir": str(request.staging_dir) if request.staging_dir else None,
            "network_domains": domains,
            "grant_ids": [],
            "sandbox_python": request.sandbox_python or "",
            "personal_write": request.personal_write,
        }

        try:
            resp = await self._client.post(
                f"{self._worker_url}/execute",
                content=json.dumps(payload, separators=(",", ":"), sort_keys=True),
                headers=self._headers(payload),
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            logger.exception("Worker RPC failed: %s", exc)
            self._auditor.finish(
                audit, status="failed",
                error_category=ExecutionErrorCategory.WORKER_CRASHED.value,
            )
            return ExecutionResult(
                exit_code=None, stdout="", stderr=str(exc),
                error_category=ExecutionErrorCategory.WORKER_CRASHED.value,
            )

        changed = [
            ExecutionFileChange(
                path=c["path"], status=c["status"],
                old_hash=c.get("old_hash"), new_hash=c.get("new_hash"),
            )
            for c in data.get("changed_files", [])
        ]

        result = ExecutionResult(
            exit_code=data.get("exit_code"),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            timed_out=data.get("timed_out", False),
            error_category=data.get("error_category"),
            changed_files=changed,
            artifacts=data.get("artifacts", []),
        )

        status = "ok" if result.exit_code == 0 or result.persistent else "failed"
        self._auditor.finish(
            audit, status=status,
            error_category=result.error_category,
            changed_paths=[c.path for c in result.changed_files],
        )
        return result

    def set_output_chunk_callback(self, callback: OutputChunkCallback | None) -> None:
        self._on_chunk = callback

    async def _forward_stream(self, execution_id: str, tool_call_id: str) -> None:
        if not self._on_chunk:
            return
        try:
            async with self._client.stream(
                "GET",
                f"{self._worker_url}/exec/stream/{execution_id}",
                headers={"Authorization": f"Bearer {self._secret}"},
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    chunk = data.get("chunk", "")
                    if chunk:
                        self._on_chunk(tool_call_id, 0, chunk)
        except httpx.HTTPError:
            logger.debug("exec stream forward ended", exc_info=True)

    async def exec_command(self, request: UnifiedExecCommandRequest) -> UnifiedExecResponse:
        domains = list(request.policy.network.domains)
        payload = {
            "execution_id": request.execution_id,
            "user_id": request.user_id,
            "session_id": request.session_id,
            "command": request.command,
            "cwd": str(request.cwd),
            "staging_dir": str(request.staging_dir) if request.staging_dir else None,
            "work_dir": str(request.work_dir) if request.work_dir else None,
            "yield_time_ms": request.yield_time_ms,
            "max_output_tokens": request.max_output_tokens,
            "tty": request.tty,
            "tool_call_id": request.tool_call_id,
            "network_domains": domains,
            "sandbox_python": request.sandbox_python or "",
            "personal_write": request.personal_write,
        }
        if self._on_chunk:
            stream_task = asyncio.create_task(
                self._forward_stream(request.execution_id, request.tool_call_id),
            )
        try:
            resp = await self._client.post(
                f"{self._worker_url}/exec/command",
                content=json.dumps(payload, separators=(",", ":"), sort_keys=True),
                headers=self._headers(payload),
                timeout=request.yield_time_ms / 1000.0 + 30,
            )
            resp.raise_for_status()
            data = resp.json()
        except asyncio.CancelledError:
            cancel_task = asyncio.create_task(self._cancel_exec(request))
            try:
                await asyncio.shield(cancel_task)
            except (asyncio.CancelledError, httpx.HTTPError):
                logger.warning("Failed to cancel worker execution %s", request.execution_id)
            raise
        except httpx.HTTPError as exc:
            return UnifiedExecResponse(
                output="",
                wall_time_seconds=0,
                error=str(exc),
            )
        finally:
            if stream_task:
                stream_task.cancel()
                try:
                    await stream_task
                except asyncio.CancelledError:
                    pass
        return UnifiedExecResponse(
            output=data.get("output", ""),
            wall_time_seconds=data.get("wall_time_seconds", 0),
            process_id=data.get("process_id"),
            exit_code=data.get("exit_code"),
            chunk_id=data.get("chunk_id", ""),
            error=data.get("error"),
            alive=data.get("alive", False),
            changed_files=[
                ExecutionFileChange(
                    path=c["path"],
                    status=c["status"],
                    old_hash=c.get("old_hash"),
                    new_hash=c.get("new_hash"),
                )
                for c in data.get("changed_files", [])
            ],
            artifacts=data.get("artifacts", []),
        )

    async def _cancel_exec(self, request: UnifiedExecCommandRequest) -> None:
        payload = {
            "execution_id": request.execution_id,
            "user_id": request.user_id,
            "session_id": request.session_id,
        }
        # The cancellation RPC can race worker-side process registration.
        # Retry briefly; this is internal traffic and never re-runs a command.
        for attempt in range(5):
            response = await self._client.post(
                f"{self._worker_url}/exec/cancel",
                content=json.dumps(payload, separators=(",", ":"), sort_keys=True),
                headers=self._headers(payload),
                timeout=5,
            )
            response.raise_for_status()
            if response.json().get("cancelled", 0) > 0:
                return
            if attempt < 4:
                await asyncio.sleep(0.1)

    async def write_stdin(self, request: UnifiedExecStdinRequest) -> UnifiedExecResponse:
        payload = {
            "user_id": request.user_id,
            "session_id": request.session_id,
            "process_id": request.process_id,
            "chars": request.chars,
            "yield_time_ms": request.yield_time_ms,
            "max_output_tokens": request.max_output_tokens,
            "tool_call_id": request.tool_call_id,
        }
        try:
            resp = await self._client.post(
                f"{self._worker_url}/exec/stdin",
                content=json.dumps(payload, separators=(",", ":"), sort_keys=True),
                headers=self._headers(payload),
                timeout=request.yield_time_ms / 1000.0 + 30,
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            return UnifiedExecResponse(
                output="",
                wall_time_seconds=0,
                error=str(exc),
            )
        return UnifiedExecResponse(
            output=data.get("output", ""),
            wall_time_seconds=data.get("wall_time_seconds", 0),
            process_id=data.get("process_id"),
            exit_code=data.get("exit_code"),
            chunk_id=data.get("chunk_id", ""),
            error=data.get("error"),
            alive=data.get("alive", False),
            changed_files=[
                ExecutionFileChange(
                    path=c["path"],
                    status=c["status"],
                    old_hash=c.get("old_hash"),
                    new_hash=c.get("new_hash"),
                )
                for c in data.get("changed_files", [])
            ],
            artifacts=data.get("artifacts", []),
        )

    async def cancel_process(self, process_id: int, user_id: str, session_id: str) -> bool:
        payload = {"process_id": process_id, "user_id": user_id, "session_id": session_id}
        try:
            response = await self._client.post(
                f"{self._worker_url}/exec/cancel",
                content=json.dumps(payload, separators=(",", ":"), sort_keys=True),
                headers=self._headers(payload), timeout=5,
            )
            response.raise_for_status()
            return response.json().get("cancelled", 0) > 0
        except httpx.HTTPError:
            logger.exception("Worker process cancellation failed")
            return False

    async def close_session(self, session_id: str) -> None:
        body = {"session_id": session_id}
        try:
            await self._client.post(
                f"{self._worker_url}/close-session",
                content=json.dumps(body),
                headers=self._headers(body),
            )
        except httpx.HTTPError:
            logger.warning("Failed to close worker session %s", session_id)

    async def health(self) -> ExecutionBackendHealth:
        try:
            resp = await self._client.get(
                f"{self._worker_url}/health",
                headers={"Authorization": f"Bearer {self._secret}"},
            )
            if resp.status_code != 200:
                return ExecutionBackendHealth(
                    available=False, backend="worker", isolation=False,
                    worker_reachable=False,
                    error=f"Worker health returned {resp.status_code}",
                )
            data = resp.json()
            isolation = data.get("isolation", False)
            return ExecutionBackendHealth(
                available=data.get("status") == "ok" and isolation,
                backend="worker",
                isolation=isolation,
                warnings=data.get("warnings", []),
                error=data.get("error"),
                persistent_python=data.get("persistent_python", False),
                oneshot=data.get("oneshot", False),
                worker_reachable=True,
                isolation_tier=data.get("isolation_tier"),
            )
        except httpx.HTTPError as exc:
            return ExecutionBackendHealth(
                available=False, backend="worker", isolation=False,
                worker_reachable=False,
                error=str(exc),
            )


def _command_summary(request: ExecutionRequest) -> str:
    if request.command:
        return " ".join(request.command)[:200]
    if request.code:
        return f"{request.runtime}: {(request.code or '').split(chr(10), 1)[0][:80]}"
    return request.runtime
