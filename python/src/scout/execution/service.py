"""High-level execution orchestration for agent tools."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Awaitable, Callable

from ..agent.file_guard import WorkspaceGuard
from ..config import AppConfig, ExecutionConfig
from .audit import ExecutionAuditor
from .errors import ExecutionErrorCategory
from .grants import CapabilityGrantStore
from .models import CapabilityRequest, ExecutionBackendHealth
from .network_proxy import EgressProxy
from .orchestrator import ExecutionOrchestrator, ToolExecutionResult

logger = logging.getLogger(__name__)

CapabilityApprovalFn = Callable[[CapabilityRequest], Awaitable[tuple[str, str]]]
PromotionApprovalFn = Callable[[str, list, dict], Awaitable[tuple[str, str]]]


class ExecutionService:
    """Routes all agent execution through the configured backend."""

    def __init__(
        self,
        *,
        config: AppConfig,
        guard: WorkspaceGuard | None,
        personal_dir: Path,
        shared_dir: Path | None,
        user_id: str,
        session_id: str,
        server_mode: bool = False,
        grant_store: CapabilityGrantStore | None = None,
        capability_approval: CapabilityApprovalFn | None = None,
        promotion_approval: PromotionApprovalFn | None = None,
        allow_shared_write: bool = False,
        shell_enabled: bool = True,
        personal_write: bool = True,
    ) -> None:
        self._config = config
        self._exec_cfg: ExecutionConfig = config.execution
        if server_mode:
            self._exec_cfg = self._exec_cfg.model_copy(update={"require_isolation": True})
        self._guard = guard
        self._personal = personal_dir.resolve()
        self._shared = shared_dir.resolve() if shared_dir else None
        self._user_id = user_id
        self._session_id = session_id
        self._server_mode = server_mode
        self._grants = grant_store or CapabilityGrantStore()
        self._capability_approval = capability_approval
        self._promotion_approval = promotion_approval
        self._allow_shared_write = allow_shared_write
        self._shell_enabled = shell_enabled
        self._personal_write = personal_write
        self._auditor = ExecutionAuditor()
        self._proxy = EgressProxy()
        self._proxy_url = os.environ.get("SCOUT_EGRESS_PROXY_URL")
        self._backend = self._create_backend()
        self._orchestrator: ExecutionOrchestrator | None = None
        self._isolation_ok = False
        self._init_error: str | None = None
        self._last_result: ToolExecutionResult | None = None
        self._output_sink: asyncio.Queue | None = None
        self._active_tool_call_id: str = ""

        if self._backend is not None:
            self._orchestrator = ExecutionOrchestrator(
                backend=self._backend,
                config=self._exec_cfg,
                personal_dir=self._personal,
                shared_dir=self._shared,
                user_id=self._user_id,
                session_id=self._session_id,
                grant_store=self._grants,
                capability_approval=self._capability_approval,
                promotion_approval=self._promotion_approval,
                path_checker=guard.is_read_denied if guard else None,
                proxy_url=self._effective_proxy_url(),
                allow_shared_write=self._allow_shared_write,
                shell_enabled=self._shell_enabled,
                personal_write=self._personal_write,
                server_mode=self._server_mode,
                sandbox_python=self._config.agent.python_path,
            )
            self._wire_chunk_callback()

    def _wire_chunk_callback(self) -> None:
        if self._backend is None:
            return

        def _on_chunk(tool_call_id: str, process_id: int, chunk: str) -> None:
            tc = tool_call_id or self._active_tool_call_id
            if self._output_sink is not None:
                try:
                    self._output_sink.put_nowait({
                        "type": "tool_output_chunk",
                        "tool_call_id": tc,
                        "process_id": process_id,
                        "chunk": chunk,
                        "name": "exec_command",
                    })
                except asyncio.QueueFull:
                    pass

        if hasattr(self._backend, "set_output_chunk_callback"):
            self._backend.set_output_chunk_callback(_on_chunk)

    def set_output_sink(self, sink: asyncio.Queue | None) -> None:
        self._output_sink = sink

    def set_active_tool_call_id(self, tool_call_id: str) -> None:
        self._active_tool_call_id = tool_call_id
        if self._orchestrator:
            self._orchestrator.set_active_tool_call_id(tool_call_id)

    @property
    def enabled(self) -> bool:
        if not self._exec_cfg.enabled or self._backend is None or self._orchestrator is None:
            return False
        if self._server_mode and self._exec_cfg.require_isolation and not self._isolation_ok:
            return False
        return True

    @property
    def auditor(self) -> ExecutionAuditor:
        return self._auditor

    @property
    def grant_store(self) -> CapabilityGrantStore:
        return self._grants

    @property
    def last_tool_result(self) -> ToolExecutionResult | None:
        return self._last_result

    def _create_backend(self):
        if not self._exec_cfg.enabled:
            return None
        backend_kind = self._resolve_backend_kind()
        if backend_kind == "disabled":
            return None
        if backend_kind == "worker":
            from .worker_backend import WorkerExecutionBackend
            return WorkerExecutionBackend(self._exec_cfg, auditor=self._auditor)
        if backend_kind == "container":
            from .container_backend import ContainerSandboxBackend
            return ContainerSandboxBackend(self._exec_cfg, auditor=self._auditor)
        from .local_backend import LocalSandboxBackend
        return LocalSandboxBackend(
            self._exec_cfg,
            conda_env=self._config.agent.conda_env,
            python_path=self._config.agent.python_path,
            auditor=self._auditor,
        )

    def _resolve_backend_kind(self) -> str:
        kind = self._exec_cfg.backend
        if kind == "auto":
            return "worker" if self._server_mode else "local-sandbox"
        return kind

    async def _ensure_health(self) -> ExecutionBackendHealth:
        if self._backend is None:
            return ExecutionBackendHealth(
                available=False, backend="disabled", isolation=False,
                error="Execution disabled",
            )
        health = await self._backend.health()
        self._isolation_ok = health.isolation
        if self._server_mode and self._exec_cfg.require_isolation:
            if not health.available or not health.isolation:
                self._init_error = (
                    health.error
                    or "User execution sandbox isolation is unavailable in server mode"
                )
                self._isolation_ok = False
            elif not health.persistent_python or not health.oneshot:
                self._init_error = (
                    "Sandbox probe failed for persistent_python or oneshot execution paths"
                )
                self._isolation_ok = False
        domains = self._grants.network_domains_for(self._user_id, self._session_id)
        self._proxy.update_domains(domains)
        # Server/docker deploys use the dedicated egress-proxy service (worker
        # side). Never bind a second in-process proxy in server mode — it races
        # on :7892 with compose and other sessions.
        if (
            domains
            and not self._server_mode
            and not self._proxy_url
            and self._proxy._server is None
        ):
            try:
                await self._proxy.start()
            except Exception as exc:
                logger.warning("Failed to start egress proxy: %s", exc)
        return health

    def _effective_proxy_url(self) -> str | None:
        if self._proxy_url:
            return self._proxy_url
        if self._server_mode:
            # Worker applies SCOUT_EGRESS_PROXY_URL for sandbox containers.
            return None
        if self._proxy._server is not None:
            return self._proxy.proxy_url
        return None

    async def health(self) -> ExecutionBackendHealth:
        health = await self._ensure_health()
        if self._server_mode:
            health = ExecutionBackendHealth(
                available=health.available and self._isolation_ok,
                backend=health.backend,
                isolation=self._isolation_ok,
                warnings=health.warnings,
                error=self._init_error or health.error,
                persistent_python=health.persistent_python,
                oneshot=health.oneshot,
                worker_reachable=health.worker_reachable,
            )
        return health

    async def close(self) -> None:
        if self._backend:
            await self._backend.close_session(self._session_id)
        await self._proxy.stop()

    async def run_python(self, code: str, description: str = "") -> ToolExecutionResult:
        await self._ensure_health()
        if not self.enabled:
            return ToolExecutionResult(_sandbox_unavailable_message(self._server_mode, self._init_error))
        assert self._orchestrator is not None
        self._last_result = await self._orchestrator.run_python(code, description)
        return self._last_result

    async def run_shell(self, command: str, description: str = "") -> ToolExecutionResult:
        await self._ensure_health()
        if not self.enabled:
            return ToolExecutionResult(_sandbox_unavailable_message(self._server_mode, self._init_error))
        assert self._orchestrator is not None
        self._last_result = await self._orchestrator.run_shell(command, description)
        return self._last_result

    async def exec_command(
        self,
        command: str,
        *,
        workdir: str = "",
        yield_time_ms: int | None = None,
        description: str = "",
        tool_call_id: str = "",
    ) -> ToolExecutionResult:
        await self._ensure_health()
        if not self.enabled:
            return ToolExecutionResult(_sandbox_unavailable_message(self._server_mode, self._init_error))
        assert self._orchestrator is not None
        self._last_result = await self._orchestrator.exec_command(
            command,
            workdir=workdir,
            yield_time_ms=yield_time_ms,
            description=description,
            tool_call_id=tool_call_id or self._active_tool_call_id,
        )
        return self._last_result

    async def write_stdin(
        self,
        session_id: int,
        chars: str = "",
        *,
        yield_time_ms: int | None = None,
        tool_call_id: str = "",
    ) -> ToolExecutionResult:
        await self._ensure_health()
        if not self.enabled:
            return ToolExecutionResult(_sandbox_unavailable_message(self._server_mode, self._init_error))
        assert self._orchestrator is not None
        self._last_result = await self._orchestrator.write_stdin(
            session_id,
            chars,
            yield_time_ms=yield_time_ms,
            tool_call_id=tool_call_id or self._active_tool_call_id,
        )
        return self._last_result

    async def run_node(self, code: str, description: str = "") -> ToolExecutionResult:
        await self._ensure_health()
        if not self.enabled:
            return ToolExecutionResult(_sandbox_unavailable_message(self._server_mode, self._init_error))
        assert self._orchestrator is not None
        self._last_result = await self._orchestrator.run_node(code, description)
        return self._last_result


def _sandbox_unavailable_message(server_mode: bool, detail: str | None = None) -> str:
    base = (
        "[SANDBOX UNAVAILABLE] User code execution is disabled because the "
        "isolated execution worker is not available. Contact an administrator."
        if server_mode else
        "[SANDBOX UNAVAILABLE] Execution sandbox is not available. "
        "Install bubblewrap or configure execution.allow_insecure_local_fallback."
    )
    if detail:
        return f"{base}\n{detail}"
    return base
