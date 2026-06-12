"""Local OS sandbox execution backend."""

from __future__ import annotations

import asyncio
import logging
import shlex
from pathlib import Path

from ..artifacts import describe_artifact
from ..config import ExecutionConfig
from .audit import ExecutionAuditor
from .changes import diff_snapshots, snapshot_writable_roots
from .errors import ExecutionErrorCategory
from .launcher import bwrap_available, drain_process_io, kill_process_tree, run_sandboxed
from .models import ExecutionBackendHealth, ExecutionRequest, ExecutionResult
from .persistent_python import PersistentPythonManager
from .policy import is_ignored_execution_path
from .unified_exec import (
    OutputChunkCallback,
    UnifiedExecCommandRequest,
    UnifiedExecManager,
    UnifiedExecResponse,
    UnifiedExecStdinRequest,
    run_in_executor,
)
from .sandbox_probe import probe_sandbox_isolation
from .staging import ExecutionStaging, snapshot_pre_promotion_hashes

logger = logging.getLogger(__name__)


class LocalSandboxBackend:
    """Execute commands with bubblewrap isolation on Linux."""

    def __init__(
        self,
        config: ExecutionConfig,
        *,
        conda_env: str = "agents",
        python_path: str | None = None,
        auditor: ExecutionAuditor | None = None,
    ) -> None:
        self._config = config
        self._auditor = auditor or ExecutionAuditor()
        self._persistent = PersistentPythonManager(
            conda_env=conda_env,
            python_path=python_path,
            timeout=config.timeout_seconds,
            allow_insecure=config.allow_insecure_local_fallback,
        )
        self._unified_exec = UnifiedExecManager(config)
        self._probe = probe_sandbox_isolation()

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

        if not self._probe.isolation and not self._config.allow_insecure_local_fallback:
            self._auditor.finish(
                audit,
                status="failed",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )
            return ExecutionResult(
                exit_code=None,
                stdout="",
                stderr=self._probe.error or "Execution sandbox unavailable",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )

        workspace_root = request.cwd
        writable = list(request.policy.write_roots)
        if request.staging_dir:
            writable.append(request.staging_dir)
        before = snapshot_writable_roots(
            tuple(writable), workspace_root=workspace_root,
        )
        if request.staging_dir:
            staging = ExecutionStaging(
                execution_id=request.execution_id,
                root=request.staging_dir,
                work_dir=request.staging_dir / "work",
                tmp_dir=request.staging_dir / "tmp",
                metadata_path=request.staging_dir / "metadata.json",
            )
            snapshot_pre_promotion_hashes(staging, workspace_root)

        try:
            if request.persistent and request.runtime == "python":
                result = await self._execute_persistent_python(request)
            elif request.runtime == "python":
                result = await self._execute_oneshot_python(request, proxy_url=proxy_url)
            elif request.runtime == "shell":
                result = await self._execute_shell(request, proxy_url=proxy_url)
            elif request.runtime == "node":
                result = await self._execute_node(request, proxy_url=proxy_url)
            else:
                result = ExecutionResult(
                    exit_code=None, stdout="", stderr=f"Unknown runtime: {request.runtime}",
                    error_category=ExecutionErrorCategory.RUNTIME_UNAVAILABLE.value,
                )
        except asyncio.TimeoutError:
            self._auditor.finish(audit, status="failed", error_category=ExecutionErrorCategory.TIMED_OUT.value)
            return ExecutionResult(
                exit_code=None, stdout="", stderr="Execution timed out",
                timed_out=True,
                error_category=ExecutionErrorCategory.TIMED_OUT.value,
            )
        except RuntimeError as exc:
            self._auditor.finish(
                audit, status="failed",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )
            return ExecutionResult(
                exit_code=None, stdout="", stderr=str(exc),
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )
        except Exception as exc:
            logger.exception("Execution failed: %s", exc)
            self._auditor.finish(audit, status="failed", error_category=ExecutionErrorCategory.WORKER_CRASHED.value)
            return ExecutionResult(
                exit_code=None, stdout="", stderr=str(exc),
                error_category=ExecutionErrorCategory.WORKER_CRASHED.value,
            )

        after = snapshot_writable_roots(
            tuple(writable), workspace_root=workspace_root,
        )
        result.changed_files = diff_snapshots(
            before, after, tuple(writable), workspace_root=workspace_root,
        )
        result.artifacts = _classify_artifacts(result.changed_files, workspace_root)

        status = "ok" if result.exit_code == 0 or result.persistent else "failed"
        if result.timed_out:
            status = "failed"
        self._auditor.finish(
            audit,
            status=status,
            error_category=result.error_category,
            changed_paths=[c.path for c in result.changed_files],
        )
        return result

    async def _execute_persistent_python(self, request: ExecutionRequest) -> ExecutionResult:
        cache = request.cwd / ".scout-cache"
        session = self._persistent.get_or_create(
            request.user_id,
            request.session_id,
            request.cwd,
            request.policy,
            cache,
            scratch_dir=request.scratch_dir,
        )
        if session is None:
            return ExecutionResult(
                exit_code=None,
                stdout="",
                stderr="Persistent Python worker unavailable (sandbox or readiness failure).",
                error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            )

        loop = asyncio.get_event_loop()
        output, success = await loop.run_in_executor(
            None, lambda: session.run(request.code or "", timeout=request.policy.timeout_seconds),
        )
        stderr = ""
        if not success and "Traceback" in output:
            stderr = output
            output = ""
        return ExecutionResult(
            exit_code=0 if success else 1,
            stdout=output,
            stderr=stderr,
            error_category=None if success else ExecutionErrorCategory.COMMAND_FAILED.value,
            persistent=True,
        )

    async def _execute_oneshot_python(
        self, request: ExecutionRequest, *, proxy_url: str | None,
    ) -> ExecutionResult:
        import sys
        python = self._persistent._python_path or sys.executable
        cmd = [python, "-c", request.code or ""]
        return await self._run_sandboxed_cmd(request, cmd, proxy_url=proxy_url)

    async def exec_command(self, request: UnifiedExecCommandRequest) -> UnifiedExecResponse:
        return await run_in_executor(self._unified_exec.exec_command, request)

    async def write_stdin(self, request: UnifiedExecStdinRequest) -> UnifiedExecResponse:
        return await run_in_executor(self._unified_exec.write_stdin, request)

    def set_output_chunk_callback(self, callback: OutputChunkCallback | None) -> None:
        self._unified_exec.set_chunk_callback(callback)

    async def _execute_shell(
        self, request: ExecutionRequest, *, proxy_url: str | None,
    ) -> ExecutionResult:
        if not request.command:
            return ExecutionResult(exit_code=1, stdout="", stderr="Empty shell command")
        cmd = ["/bin/sh", "-c", " ".join(request.command)]
        return await self._run_sandboxed_cmd(request, cmd, proxy_url=proxy_url)

    async def _execute_node(
        self, request: ExecutionRequest, *, proxy_url: str | None,
    ) -> ExecutionResult:
        node = _find_binary("node")
        if not node:
            return ExecutionResult(
                exit_code=None, stdout="", stderr="Node.js runtime not found",
                error_category=ExecutionErrorCategory.RUNTIME_UNAVAILABLE.value,
            )
        cmd = [node, "-e", request.code or ""]
        return await self._run_sandboxed_cmd(request, cmd, proxy_url=proxy_url)

    async def _run_sandboxed_cmd(
        self, request: ExecutionRequest, cmd: list[str], *, proxy_url: str | None,
    ) -> ExecutionResult:
        loop = asyncio.get_event_loop()

        def _run() -> ExecutionResult:
            if bwrap_available() and self._probe.isolation:
                proc = run_sandboxed(
                    cmd,
                    cwd=request.cwd,
                    env=dict(request.environment),
                    policy=request.policy,
                    timeout=request.policy.timeout_seconds,
                    private_tmp=request.staging_dir / "tmp" if request.staging_dir else None,
                    proxy_url=proxy_url,
                    workspace_root=request.cwd,
                    sandbox_python=request.sandbox_python or self._persistent.sandbox_python,
                )
                stdout = _truncate(proc.stdout or "", request.policy.max_output_bytes)
                stderr = _truncate(proc.stderr or "", request.policy.max_output_bytes)
                return ExecutionResult(
                    exit_code=proc.returncode,
                    stdout=stdout,
                    stderr=stderr,
                    error_category=(
                        None if proc.returncode == 0
                        else ExecutionErrorCategory.COMMAND_FAILED.value
                    ),
                )

            if not self._config.allow_insecure_local_fallback:
                return ExecutionResult(
                    exit_code=None, stdout="", stderr="Sandbox unavailable",
                    error_category=ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
                )

            import subprocess
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                cwd=str(request.cwd), env=dict(request.environment),
                start_new_session=True,
            )
            try:
                stdout, stderr = proc.communicate(timeout=request.policy.timeout_seconds)
            except subprocess.TimeoutExpired:
                kill_process_tree(proc.pid)
                drain_process_io(proc)
                return ExecutionResult(
                    exit_code=None, stdout="", stderr="Execution timed out",
                    timed_out=True,
                    error_category=ExecutionErrorCategory.TIMED_OUT.value,
                )
            return ExecutionResult(
                exit_code=proc.returncode,
                stdout=_truncate(stdout or "", request.policy.max_output_bytes),
                stderr=_truncate(stderr or "", request.policy.max_output_bytes),
                error_category=(
                    None if proc.returncode == 0
                    else ExecutionErrorCategory.COMMAND_FAILED.value
                ),
            )

        return await loop.run_in_executor(None, _run)

    async def close_session(self, session_id: str) -> None:
        self._persistent.close_session(session_id)
        await run_in_executor(self._unified_exec.close_session, session_id)

    async def health(self) -> ExecutionBackendHealth:
        warnings: list[str] = list(self._probe.warnings)
        if not self._probe.isolation:
            if self._config.allow_insecure_local_fallback:
                warnings.append(
                    "Sandbox isolation probe failed — running with insecure local fallback "
                    "(not suitable for production)"
                )
                return ExecutionBackendHealth(
                    available=True,
                    backend="local-sandbox",
                    isolation=False,
                    warnings=warnings,
                    persistent_python=False,
                    oneshot=False,
                    error=self._probe.error,
                )
            return ExecutionBackendHealth(
                available=False,
                backend="local-sandbox",
                isolation=False,
                warnings=warnings,
                error=self._probe.error or "sandbox isolation unavailable",
                persistent_python=self._probe.persistent_python,
                oneshot=self._probe.oneshot,
            )
        return ExecutionBackendHealth(
            available=True,
            backend="local-sandbox",
            isolation=True,
            warnings=warnings,
            persistent_python=self._probe.persistent_python,
            oneshot=self._probe.oneshot,
        )


def _command_summary(request: ExecutionRequest) -> str:
    if request.command:
        return " ".join(request.command)[:200]
    if request.code:
        first = (request.code or "").split("\n", 1)[0][:80]
        return f"{request.runtime}: {first}"
    return request.runtime


def _truncate(text: str, max_bytes: int) -> str:
    if len(text.encode("utf-8")) <= max_bytes:
        return text
    return text[: max_bytes // 2] + "\n…[truncated]…\n" + text[-max_bytes // 4 :]


def _find_binary(name: str) -> str | None:
    import shutil
    return shutil.which(name)


def _classify_artifacts(changes, workspace_root: Path) -> list[dict]:
    artifacts: list[dict] = []
    for change in changes:
        if change.status == "deleted":
            continue
        path = Path(change.path)
        if is_ignored_execution_path(path, workspace_root):
            continue
        art = describe_artifact(path, workspace_root)
        if art:
            artifacts.append(art)
    return artifacts
