"""ExecutionBackend protocol."""

from __future__ import annotations

from typing import Protocol

from .models import ExecutionBackendHealth, ExecutionRequest, ExecutionResult
from .unified_exec import (
    OutputChunkCallback,
    UnifiedExecCommandRequest,
    UnifiedExecResponse,
    UnifiedExecStdinRequest,
)


class ExecutionBackend(Protocol):
    async def execute(
        self, request: ExecutionRequest, *, proxy_url: str | None = None,
    ) -> ExecutionResult: ...
    async def exec_command(self, request: UnifiedExecCommandRequest) -> UnifiedExecResponse: ...
    async def write_stdin(self, request: UnifiedExecStdinRequest) -> UnifiedExecResponse: ...
    async def cancel_process(self, process_id: int, user_id: str, session_id: str) -> bool: ...
    def set_output_chunk_callback(self, callback: OutputChunkCallback | None) -> None: ...
    async def close_session(self, session_id: str) -> None: ...
    async def health(self) -> ExecutionBackendHealth: ...
