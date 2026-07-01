"""Codex-style execution orchestration pipeline."""

from __future__ import annotations

import logging
import shlex
import shutil
import uuid
import hashlib
from pathlib import Path
from typing import Awaitable, Callable

from ..agent.file_guard import scan_code_for_denied_paths
from ..agent.file_tracker import FileDiff, exact_file_diff
from ..artifacts import describe_artifact, html_artifact_warning
from ..config import ExecutionConfig
from .backend import ExecutionBackend
from .errors import ExecutionErrorCategory
from .grants import CapabilityGrantStore
from .models import CapabilityRequest, ExecutionRequest, ExecutionResult
from .path_aliases import translate_workspace_paths
from .execpolicy import PolicyMatch, match_policy
from .policy import build_execution_environment, build_execution_policy
from .runtime import resolve_sandbox_python
from .staging import (
    ExecutionStaging,
    check_promotion_conflicts,
    create_staging,
    discard_staging,
    promote_staged_files,
    snapshot_pre_promotion_hashes,
)
from .changes import diff_snapshots, snapshot_writable_roots
from .unified_exec import UnifiedExecCommandRequest, UnifiedExecStdinRequest

logger = logging.getLogger(__name__)


def _replace_symlink(link: Path, target: Path) -> None:
    if link.is_symlink() or link.exists():
        try:
            if link.is_symlink() and link.resolve() == target.resolve():
                return
            link.unlink()
        except OSError:
            return
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError:
        return

CapabilityApprovalFn = Callable[[CapabilityRequest], Awaitable[tuple[str, str]]]
PromotionApprovalFn = Callable[[str, list[FileDiff], dict], Awaitable[tuple[str, str]]]


class ToolExecutionResult:
    def __init__(
        self,
        text: str,
        artifacts: list[dict] | None = None,
        promotion_diffs: list[FileDiff] | None = None,
    ) -> None:
        self.text = text
        self.artifacts = artifacts or []
        self.promotion_diffs = promotion_diffs or []


class ExecutionOrchestrator:
    """approval → policy → sandbox → execute → promotion."""

    def __init__(
        self,
        *,
        backend: ExecutionBackend,
        config: ExecutionConfig,
        personal_dir: Path,
        shared_dir: Path | None,
        user_id: str,
        session_id: str,
        grant_store: CapabilityGrantStore,
        capability_approval: CapabilityApprovalFn | None = None,
        promotion_approval: PromotionApprovalFn | None = None,
        path_checker=None,
        proxy_url: str | None = None,
        allow_shared_write: bool = False,
        shell_enabled: bool = True,
        personal_write: bool = True,
        server_mode: bool = False,
        sandbox_python: str | None = None,
    ) -> None:
        self._backend = backend
        self._config = config
        self._personal = personal_dir.resolve()
        self._shared = shared_dir.resolve() if shared_dir else None
        self._user_id = user_id
        self._session_id = session_id
        self._grants = grant_store
        self._capability_approval = capability_approval
        self._promotion_approval = promotion_approval
        self._path_checker = path_checker
        self._proxy_url = proxy_url
        self._allow_shared_write = allow_shared_write
        self._shell_enabled = shell_enabled
        self._personal_write = personal_write
        self._server_mode = server_mode
        self._sandbox_python = resolve_sandbox_python(sandbox_python)
        self._session_exec_rules: list[str] = []
        self._approval_cache: dict[str, bool] = {}
        self._pending_once_grants: list[str] = []
        self._last_capability: str | None = None
        self._pending_staging: dict[int, ExecutionStaging] = {}
        self._active_tool_call_id: str = ""

    def _cache_key(self, runtime: str, cwd: Path, policy_hash: str) -> str:
        return f"{runtime}:{cwd}:{policy_hash}"

    def _policy_hash(self, domains: tuple[str, ...]) -> str:
        payload = "|".join(domains)
        return hashlib.sha256(payload.encode()).hexdigest()[:16]

    async def run_python(self, code: str, description: str = "") -> ToolExecutionResult:
        denied = scan_code_for_denied_paths(
            code, base_dir=self._personal, path_checker=self._path_checker,
        )
        if denied:
            return ToolExecutionResult(
                f"[Access denied: code references protected paths: {', '.join(denied)}]"
            )

        scratch = self._personal / ".scout-cache" / "session-scratch" / self._session_id
        scratch.mkdir(parents=True, exist_ok=True)
        self._prepare_python_workspace_aliases(scratch)
        before = snapshot_writable_roots((scratch,))
        scratch_relative = scratch.relative_to(self._personal)
        wrapped_code = (
            "import os as _scout_os\n"
            "if '_SCOUT_PYTHON_WORKDIR' not in globals():\n"
            f"    _SCOUT_PYTHON_WORKDIR = _scout_os.path.abspath({str(scratch_relative)!r})\n"
            "_scout_os.chdir(_SCOUT_PYTHON_WORKDIR)\n"
            + self._python_workspace_path_preamble()
            + code
        )
        staging = create_staging(self._personal)
        req = self._make_request(
            "python", code=wrapped_code, staging=staging, persistent=True,
            cwd=self._personal, scratch_dir=scratch,
        )
        result = await self._backend.execute(req, proxy_url=self._proxy_url)
        after = snapshot_writable_roots((scratch,))
        for change in diff_snapshots(before, after, (scratch,)):
            source = Path(change.path)
            target = staging.work_dir / source.relative_to(scratch)
            if change.status == "deleted":
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        return await self._finalize(result, staging, description or "run_python")

    def _prepare_python_workspace_aliases(self, scratch: Path) -> None:
        """Expose the prompt's `workspace/` path from the Python scratch cwd."""
        workspace = scratch / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)

        users = workspace / "users"
        users.mkdir(exist_ok=True)
        _replace_symlink(users / self._user_id, self._personal)

        if self._shared is not None:
            _replace_symlink(workspace / "shared", self._shared)

        for entry in self._personal.iterdir():
            if entry.name in {".scout-cache", ".scout-executions", "workspace"}:
                continue
            alias = workspace / entry.name
            if alias.exists() or alias.is_symlink():
                continue
            try:
                alias.symlink_to(entry, target_is_directory=entry.is_dir())
            except OSError:
                # The Python preamble still translates these paths for libraries
                # that call open/stat directly, so aliases are best-effort.
                continue

    def _python_workspace_path_preamble(self) -> str:
        shared = str(self._shared) if self._shared is not None else ""
        return f"""
import builtins as _scout_builtins
import io as _scout_io
import os as _scout_path_os
import os.path as _scout_path_op
if '_SCOUT_WORKSPACE_PATH_ALIASES_READY' not in globals():
    _SCOUT_WORKSPACE_PATH_ALIASES_READY = True
    _SCOUT_PERSONAL_ROOT = {str(self._personal)!r}
    _SCOUT_SHARED_ROOT = {shared!r}
    _SCOUT_USER_ID = {self._user_id!r}
    def _scout_translate_workspace_path(_p):
        try:
            _s = _scout_path_os.fspath(_p)
        except TypeError:
            return _p
        if not isinstance(_s, str):
            return _p
        _prefixes = ('/app/workspace/', '/workspace/', 'workspace/')
        _rest = None
        for _prefix in _prefixes:
            if _s == _prefix.rstrip('/'):
                _rest = ''
                break
            if _s.startswith(_prefix):
                _rest = _s[len(_prefix):]
                break
        if _rest is None:
            _user_prefix = 'users/' + _SCOUT_USER_ID + '/'
            if _s == 'users/' + _SCOUT_USER_ID:
                return _SCOUT_PERSONAL_ROOT
            if _s.startswith(_user_prefix):
                return _scout_path_op.join(_SCOUT_PERSONAL_ROOT, _s[len(_user_prefix):])
            return _p
        if not _rest:
            return _SCOUT_PERSONAL_ROOT
        _parts = _rest.split('/')
        if len(_parts) >= 2 and _parts[0] == 'users' and _parts[1] == _SCOUT_USER_ID:
            return _scout_path_op.join(_SCOUT_PERSONAL_ROOT, *_parts[2:])
        if _parts[0] == 'shared' and _SCOUT_SHARED_ROOT:
            return _scout_path_op.join(_SCOUT_SHARED_ROOT, *_parts[1:])
        return _scout_path_op.join(_SCOUT_PERSONAL_ROOT, *_parts)
    _scout_open_prev = _scout_builtins.open
    _scout_io_open_prev = _scout_io.open
    def _scout_open_workspace_alias(_file, *args, **kwargs):
        return _scout_open_prev(_scout_translate_workspace_path(_file), *args, **kwargs)
    def _scout_io_open_workspace_alias(_file, *args, **kwargs):
        return _scout_io_open_prev(_scout_translate_workspace_path(_file), *args, **kwargs)
    _scout_builtins.open = _scout_open_workspace_alias
    _scout_io.open = _scout_io_open_workspace_alias
    _scout_stat_prev = _scout_path_os.stat
    _scout_lstat_prev = _scout_path_os.lstat
    _scout_listdir_prev = _scout_path_os.listdir
    _scout_scandir_prev = _scout_path_os.scandir
    def _scout_stat_workspace_alias(_path, *args, **kwargs):
        return _scout_stat_prev(_scout_translate_workspace_path(_path), *args, **kwargs)
    def _scout_lstat_workspace_alias(_path, *args, **kwargs):
        return _scout_lstat_prev(_scout_translate_workspace_path(_path), *args, **kwargs)
    def _scout_listdir_workspace_alias(_path='.'):
        return _scout_listdir_prev(_scout_translate_workspace_path(_path))
    def _scout_scandir_workspace_alias(_path='.'):
        return _scout_scandir_prev(_scout_translate_workspace_path(_path))
    _scout_path_os.stat = _scout_stat_workspace_alias
    _scout_path_os.lstat = _scout_lstat_workspace_alias
    _scout_path_os.listdir = _scout_listdir_workspace_alias
    _scout_path_os.scandir = _scout_scandir_workspace_alias
"""

    def set_active_tool_call_id(self, tool_call_id: str) -> None:
        self._active_tool_call_id = tool_call_id

    def _resolve_workdir(self, workdir: str) -> Path:
        """Resolve a tool-supplied workdir into a real cwd under the workspace.

        The file tools and system prompt present the personal workspace as
        ``workspace/`` (and the shared repo as ``workspace/shared/``), so the
        model naturally passes ``workdir="workspace"``. Without alias handling
        that joins to ``<personal>/workspace`` — a nested directory — and any
        file written there is described as an artifact but lives one level
        below where the artifact endpoint serves from, yielding
        "Artifact is unavailable". Mirror ``_resolve_workspace_path`` from the
        agent tools so shell and file tools agree on where ``workspace`` is.
        """
        if not workdir:
            return self._personal

        candidate = Path(workdir)
        if candidate.is_absolute():
            parts = candidate.parts
            if "workspace" in parts:
                parts = parts[parts.index("workspace") + 1:]
            else:
                parts = ()
        else:
            parts = candidate.parts
            if parts[:1] == ("workspace",):
                parts = parts[1:]

        uid = str(self._user_id)
        target: Path
        if parts[:2] == ("users", uid):
            target = self._personal.joinpath(*parts[2:])
        elif parts[:1] == ("shared",) and self._shared is not None:
            target = self._shared.joinpath(*parts[1:])
        else:
            target = self._personal.joinpath(*parts)

        target = target.resolve()
        for root in (self._personal, self._shared):
            if root is None:
                continue
            try:
                target.relative_to(root.resolve())
                return target
            except ValueError:
                continue
        return self._personal

    def _translate_shell_workspace_paths(self, command: str) -> str:
        """Make file-tool workspace paths usable inside shell commands.

        File tools intentionally show stable paths such as
        ``workspace/shared/data.csv``. Shell commands, however, run with the
        personal directory as their cwd and historically interpreted that as
        ``<personal>/workspace/shared/data.csv``. Translate the stable aliases
        at the execution boundary so models do not need backend-specific path
        knowledge or retries.

        The worker repeats this translation after RPC because its mount roots
        can differ from the API server's roots.
        """
        return translate_workspace_paths(
            command,
            personal_root=self._personal,
            shared_root=self._shared,
            user_id=self._user_id,
        )

    async def exec_command(
        self,
        command: str,
        *,
        workdir: str = "",
        yield_time_ms: int | None = None,
        description: str = "",
        tool_call_id: str = "",
    ) -> ToolExecutionResult:
        if not self._config.unified_shell:
            return await self.run_shell(command, description)
        if not self._shell_enabled:
            return ToolExecutionResult("[SHELL DISABLED] Shell execution is not allowed for this permission profile.")
        policy_result, cap_err = await self._check_shell_command(command)
        if cap_err:
            return cap_err

        staging = create_staging(self._personal)
        snapshot_pre_promotion_hashes(staging, self._personal)
        cwd = self._resolve_workdir(workdir)
        executable_command = self._translate_shell_workspace_paths(command)

        req = UnifiedExecCommandRequest(
            execution_id=staging.execution_id,
            user_id=self._user_id,
            session_id=self._session_id,
            command=executable_command,
            cwd=cwd,
            policy=self._shell_policy(staging),
            staging_dir=staging.root,
            work_dir=staging.work_dir,
            yield_time_ms=yield_time_ms or self._config.default_yield_time_ms,
            max_output_tokens=10_000,
            tool_call_id=tool_call_id or self._active_tool_call_id,
            proxy_url=self._proxy_url,
            allow_insecure_fallback=self._config.allow_insecure_local_fallback,
            personal_write=self._personal_write,
            sandbox_python=self._sandbox_python,
        )
        resp = await self._backend.exec_command(req)
        if resp.error:
            discard_staging(staging)
            return ToolExecutionResult(f"[EXEC ERROR] {resp.error}")
        if resp.alive and resp.process_id is not None:
            self._pending_staging[resp.process_id] = staging
            return ToolExecutionResult(resp.output)
        return await self._finalize_shell_result(resp, staging, description or command[:80])

    async def write_stdin(
        self,
        session_id: int,
        chars: str = "",
        *,
        yield_time_ms: int | None = None,
        tool_call_id: str = "",
    ) -> ToolExecutionResult:
        if not self._config.unified_shell:
            return ToolExecutionResult("[UNIFIED EXEC DISABLED] write_stdin requires unified_shell.")
        if not self._shell_enabled:
            return ToolExecutionResult("[SHELL DISABLED] Shell execution is not allowed for this permission profile.")

        req = UnifiedExecStdinRequest(
            user_id=self._user_id,
            session_id=self._session_id,
            process_id=session_id,
            chars=chars,
            yield_time_ms=yield_time_ms or self._config.default_yield_time_ms,
            max_output_tokens=10_000,
            tool_call_id=tool_call_id or self._active_tool_call_id,
        )
        resp = await self._backend.write_stdin(req)
        if resp.error:
            staging = self._pending_staging.pop(session_id, None)
            if staging:
                discard_staging(staging)
            return ToolExecutionResult(f"[EXEC ERROR] {resp.error}")

        staging = self._pending_staging.get(session_id)
        if resp.alive:
            return ToolExecutionResult(resp.output)
        if staging:
            self._pending_staging.pop(session_id, None)
            return await self._finalize_shell_result(resp, staging, f"write_stdin({session_id})")
        return ToolExecutionResult(resp.output)

    async def _finalize_shell_result(
        self, resp, staging: ExecutionStaging, summary: str,
    ) -> ToolExecutionResult:
        result = ExecutionResult(
            exit_code=resp.exit_code,
            stdout=resp.output,
            stderr="",
            error_category=None if (resp.exit_code == 0) else ExecutionErrorCategory.COMMAND_FAILED.value,
            changed_files=resp.changed_files,
            artifacts=resp.artifacts,
        )
        return await self._finalize(result, staging, summary)

    async def _check_shell_command(self, command: str) -> tuple[PolicyMatch, ToolExecutionResult | None]:
        policy_result = match_policy(
            command,
            personal_dir=self._personal,
            server_mode=self._server_mode,
            project_dir=self._personal,
            session_rules=self._session_exec_rules,
        )
        if policy_result == PolicyMatch.DENY:
            return policy_result, ToolExecutionResult(
                f"[SHELL DENIED] Command blocked by execpolicy: {command[:100]}"
            )
        skip_capability = policy_result == PolicyMatch.ALLOW
        if not skip_capability and self._needs_network(command):
            if not self._grants.network_domains_for(self._user_id, self._session_id):
                cap = CapabilityRequest(
                    capability="network_domain",
                    reason="Shell command requires network access",
                    scope={"domains": self._infer_domains(command)},
                    command_summary=command[:200],
                )
                if not await self._request_capability(cap):
                    return policy_result, ToolExecutionResult(
                        f"[Capability denied: network access required for: {command[:100]}]"
                    )
        return policy_result, None

    def _shell_policy(self, staging: ExecutionStaging):
        domains = self._grants.network_domains_for(self._user_id, self._session_id)
        return build_execution_policy(
            personal_dir=self._personal,
            shared_dir=self._shared,
            config=self._config,
            allow_shared_write=self._allow_shared_write,
            personal_write=self._personal_write,
            network_domains=domains,
            staging_dir=None,
        )

    async def run_shell(self, command: str, description: str = "") -> ToolExecutionResult:
        if not self._shell_enabled:
            return ToolExecutionResult("[SHELL DISABLED] Shell execution is not allowed for this permission profile.")
        policy_result = match_policy(
            command,
            personal_dir=self._personal,
            server_mode=self._server_mode,
            project_dir=self._personal,
            session_rules=self._session_exec_rules,
        )
        if policy_result == PolicyMatch.DENY:
            return ToolExecutionResult(f"[SHELL DENIED] Command blocked by execpolicy: {command[:100]}")
        used_capability: str | None = None
        skip_capability = policy_result == PolicyMatch.ALLOW
        if not skip_capability and self._needs_network(command):
            if not self._grants.network_domains_for(self._user_id, self._session_id):
                cap = CapabilityRequest(
                    capability="network_domain",
                    reason="Shell command requires network access",
                    scope={"domains": self._infer_domains(command)},
                    command_summary=command[:200],
                )
                if not await self._request_capability(cap):
                    return ToolExecutionResult(
                        f"[Capability denied: network access required for: {command[:100]}]"
                    )
            used_capability = "network"

        staging = create_staging(self._personal)
        snapshot_pre_promotion_hashes(staging, self._personal)
        req = self._make_request(
            "shell",
            command=tuple(shlex.split(command)),
            staging=staging,
            cwd=staging.work_dir,
        )
        result = await self._backend.execute(req, proxy_url=self._proxy_url)
        self._consume_once_on_success(result, used_capability)
        return await self._finalize(result, staging, description or command[:80])

    def add_session_exec_rule(self, prefix: str) -> None:
        if prefix and prefix not in self._session_exec_rules:
            self._session_exec_rules.append(prefix)

    def save_exec_rule(self, prefix: str, scope: str = "always") -> str | None:
        from .execpolicy import add_rule
        if scope == "session":
            self.add_session_exec_rule(prefix)
            return None
        return add_rule(
            prefix,
            scope="always",
            personal_dir=self._personal,
            server_mode=self._server_mode,
        )

    async def run_node(self, code: str, description: str = "") -> ToolExecutionResult:
        staging = create_staging(self._personal)
        snapshot_pre_promotion_hashes(staging, self._personal)
        req = self._make_request("node", code=code, staging=staging, cwd=staging.work_dir)
        result = await self._backend.execute(req, proxy_url=self._proxy_url)
        return await self._finalize(result, staging, description or "run_node")

    def _make_request(
        self,
        runtime: str,
        *,
        code: str | None = None,
        command: tuple[str, ...] | None = None,
        staging: ExecutionStaging,
        cwd: Path,
        persistent: bool = False,
        scratch_dir: Path | None = None,
    ) -> ExecutionRequest:
        domains = self._grants.network_domains_for(self._user_id, self._session_id)
        policy = build_execution_policy(
            personal_dir=self._personal,
            shared_dir=self._shared,
            config=self._config,
            allow_shared_write=self._allow_shared_write,
            personal_write=self._personal_write,
            network_domains=domains,
            staging_dir=staging.work_dir,
            scratch_dir=scratch_dir,
            persistent=persistent,
        )
        env = build_execution_environment(self._personal, sandbox_python=self._sandbox_python)
        return ExecutionRequest(
            execution_id=staging.execution_id,
            user_id=self._user_id,
            session_id=self._session_id,
            runtime=runtime,  # type: ignore[arg-type]
            command=command,
            code=code,
            cwd=cwd,
            policy=policy,
            environment=env,
            persistent=persistent,
            staging_dir=staging.root,
            scratch_dir=scratch_dir,
            sandbox_python=self._sandbox_python,
            personal_write=self._personal_write,
        )

    async def _request_capability(self, cap: CapabilityRequest) -> bool:
        cache_key = self._cache_key(
            cap.capability,
            self._personal,
            self._policy_hash(tuple(cap.scope.get("domains", []))),
        )
        if cache_key in self._approval_cache:
            return self._approval_cache[cache_key]

        if self._capability_approval is None:
            return False

        action, _scope = await self._capability_approval(cap)
        if action in {"yes", "allow_once"}:
            grant_id = str(uuid.uuid4())
            self._grants.add(
                grant_id, self._user_id, self._session_id,
                cap.capability, cap.scope, grant_scope="once",
            )
            self._pending_once_grants.append(grant_id)
            self._last_capability = cap.capability
            self._approval_cache[cache_key] = True
            return True
        if action in {"always", "allow_session"}:
            self._grants.add(
                str(uuid.uuid4()), self._user_id, self._session_id,
                cap.capability, cap.scope, grant_scope="session",
            )
            self._approval_cache[cache_key] = True
            return True
        self._approval_cache[cache_key] = False
        return False

    def _consume_once_on_success(
        self, result: ExecutionResult, capability: str | None,
    ) -> None:
        if capability is None:
            return
        if result.exit_code != 0 and not result.persistent:
            return
        if result.error_category:
            return
        for grant_id in list(self._pending_once_grants):
            self._grants.consume_once(grant_id)
        self._pending_once_grants.clear()

    async def _finalize(
        self,
        result: ExecutionResult,
        staging: ExecutionStaging,
        summary: str,
    ) -> ToolExecutionResult:
        if result.error_category in {
            ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value,
            ExecutionErrorCategory.CAPABILITY_APPROVAL_REQUIRED.value,
            ExecutionErrorCategory.ARTIFACT_PROMOTION_CONFLICT.value,
        }:
            discard_staging(staging)
            return ToolExecutionResult(_format_result(result))

        artifacts: list[dict] = list(result.artifacts)
        staged_changes = _staged_file_diffs(staging, self._personal)

        if staged_changes and self._promotion_approval:
            action, feedback = await self._promotion_approval(
                "execution_promotion", staged_changes, {"summary": summary},
            )
            if action in {"yes", "always"}:
                conflicts = check_promotion_conflicts(staging, self._personal)
                if conflicts:
                    discard_staging(staging)
                    names = ", ".join(c.path for c in conflicts)
                    return ToolExecutionResult(
                        f"[PROMOTION CONFLICT] Files changed in workspace during execution: {names}"
                    )
                for _, dest in promote_staged_files(staging, self._personal):
                    art = describe_artifact(dest, self._personal)
                    if art:
                        artifacts.append(art)
                discard_staging(staging)
            elif action == "no":
                discard_staging(staging)
                return ToolExecutionResult(
                    "[STAGED WRITES REJECTED] " + _format_result(result),
                    artifacts=artifacts,
                )
            else:
                discard_staging(staging)
                return ToolExecutionResult(
                    f"[PROMOTION FEEDBACK] {feedback}\n" + _format_result(result),
                )
        else:
            discard_staging(staging)

        warnings = [
            html_artifact_warning(self._personal / artifact["path"])
            for artifact in artifacts
            if artifact.get("renderer") == "html"
        ]
        text = _format_result(result)
        warnings = [warning for warning in warnings if warning]
        if warnings:
            text = "\n".join([text, *warnings]).strip()
        return ToolExecutionResult(text, artifacts=artifacts)

    @staticmethod
    def _needs_network(command: str) -> bool:
        network_cmds = {"curl", "wget", "pip", "uv", "npm", "npx", "git", "ssh"}
        try:
            tokens = shlex.split(command)
        except ValueError:
            return False
        if not tokens:
            return False
        first = Path(tokens[0]).name
        if first in network_cmds:
            return True
        if first.startswith("python") and len(tokens) >= 3 and tokens[1] == "-m":
            return tokens[2] in {"pip", "npm"}
        return False

    @staticmethod
    def _infer_domains(command: str) -> list[str]:
        lower = command.lower()
        if "pip" in lower or "uv " in lower:
            return ["pypi.org", "files.pythonhosted.org"]
        if "npm" in lower or "npx" in lower:
            return ["registry.npmjs.org"]
        return []


def _format_result(result: ExecutionResult) -> str:
    if result.error_category == ExecutionErrorCategory.SANDBOX_UNAVAILABLE.value:
        return f"[SANDBOX UNAVAILABLE] {result.stderr}"
    if result.error_category == ExecutionErrorCategory.TIMED_OUT.value:
        return f"[TIMED OUT] {result.stderr or 'Execution exceeded time limit'}"
    if result.error_category == ExecutionErrorCategory.ARTIFACT_PROMOTION_CONFLICT.value:
        return f"[PROMOTION CONFLICT] {result.stderr}"
    parts = []
    if result.stdout:
        parts.append(result.stdout)
    if result.stderr:
        parts.append(result.stderr)
    text = "\n".join(parts).strip()
    if text:
        return text
    if result.exit_code == 0 or result.persistent:
        return "[Code ran successfully but produced no output. Use explicit print(...).]"
    return "[Execution failed]"


def _staged_file_diffs(staging: ExecutionStaging, workspace_root: Path) -> list[FileDiff]:
    diffs: list[FileDiff] = []
    for src in staging.work_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(staging.work_dir)
        workspace_dest = workspace_root / rel
        diffs.append(exact_file_diff(
            workspace_dest, workspace_root,
            workspace_dest.read_bytes() if workspace_dest.exists() else None,
            src.read_bytes(),
        ))
    return diffs
