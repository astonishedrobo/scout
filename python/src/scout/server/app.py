"""FastAPI application for the Scout agent server.

Exposes:
- ``POST /chat``      – SSE stream of agent events
- ``POST /reset``     – Clear conversation
- ``POST /restore``   – Restore conversation from persisted session
- ``GET  /health``    – Server health check
- ``GET  /config``    – Return merged config
- ``POST /config``    – Update a config value
- ``POST /approval``  – Respond to a file-write approval request
- ``GET  /sessions``  – List persisted sessions
- ``POST /sessions``  – Create a new session
- ``GET  /sessions/{id}`` – Load a session
- ``POST /sessions/{id}/messages`` – Append a message
- ``DELETE /sessions/{id}`` – Delete a session
- ``GET  /files``     – List workspace files (for @-mention autocomplete)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os as _os
import shutil
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import Depends, FastAPI, HTTPException, Query, UploadFile, File as FAFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from ..agent import ScoutAgent
from ..agent.exceptions import ProviderRateLimitError
from ..agent.file_guard import WorkspaceGuard
from ..execution.grants import CapabilityGrantStore
from ..execution.models import CapabilityRequest
from ..artifacts import MAX_ARTIFACT_SIZE, RENDERERS
from ..config import (
    GLOBAL_CONFIG_PATH,
    AppConfig,
    config_hash,
    load_config,
    load_deployment_config,
    redacted_config,
)
from ..retriever import RetrieverProxy
from .attachments import build_attachment_notes
from ..agent.multimodal import image_paths
from ..model_capabilities import model_vision_support
from ..chat_images import asset_dir, resolve_asset, resolve_assets, validate_and_store
from .auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    User,
    create_access_token,
    create_user,
    get_current_user,
    get_current_user_optional,
    get_user_memory_preferences,
    get_user_by_username,
    get_user_permission_profile,
    is_user_admin,
    list_users,
    set_user_admin,
    set_user_memory_preferences,
    set_user_permission_profile,
    verify_password,
)
from ..hooks import run_hook
from ..memories import (
    add_memory,
    list_memory_entries,
    load_memory_registry,
    load_memory_summary,
    remove_memory,
    save_memory_registry,
    save_memory_summary,
)
from ..memory_pipeline import schedule_memory_pipeline
from ..permissions import profile_from_user, resolve_profile
from ..session_snapshot import copy_session_snapshot, load_session_snapshot, save_session_snapshot
from .session_title import (
    DEFAULT_SESSION_TITLE,
    LEGACY_DEFAULT_TITLES,
    generate_session_title,
)
from .workspace import ensure_workspaces, shared_workspace, user_workspace
from datetime import timedelta

logger = logging.getLogger(__name__)

# ── Request / response models ────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str
    session_id: str
    attachments: list[str] = []  # list of absolute file paths
    chat_image_ids: list[str] = []


class ConfigSetRequest(BaseModel):
    key: str        # dotted path, e.g. "agent.model"
    value: Any
    scope: str = "project"  # "global" or "project"


class SessionModelRequest(BaseModel):
    model: str


class SessionTitleRequest(BaseModel):
    title: str


class ApprovalResponse(BaseModel):
    approval_id: str
    action: str       # "yes", "no", "suggest", "edit", "always", "shared", "allow_once", "allow_session", "deny"
    feedback: str = ""
    kind: str = "file_changes"  # "file_changes" | "capability" | "permission_elevation"
    save_execpolicy: bool = False
    execpolicy_prefix: str = ""
    execpolicy_scope: str = "session"


# ── App factory ──────────────────────────────────────────────────────────


class RestoreRequest(BaseModel):
    """Restore agent conversation history from a persisted session."""
    messages: list[dict]  # [{"role": "user"|"assistant", "content": "..."}]


class InitSkillRequest(BaseModel):
    directory_summary: str = ""


class SaveSkillRequest(BaseModel):
    content: str


class SessionMessageRequest(BaseModel):
    role: str  # "user" | "assistant"
    content: str
    steps: list[dict] | None = None
    model: str | None = None
    attachments: list[str] | None = None
    artifacts: list[dict] | None = None
    chat_images: list[dict] | None = None


# ── Session store helpers (matches Node.js JSONL format) ─────────────────

SESSIONS_ROOT = Path.home() / ".config" / "scout" / "sessions"

def _project_hash(cwd: str) -> str:
    return hashlib.sha256(str(Path(cwd).resolve()).encode()).hexdigest()[:12]

def _session_dir(cwd: str, user_id: str | int = "default") -> Path:
    return SESSIONS_ROOT / str(user_id) / _project_hash(cwd)

def _session_file(cwd: str, session_id: str, user_id: str | int = "default") -> Path:
    return _session_dir(cwd, user_id) / f"{session_id}.jsonl"

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _set_session_title(session_path: Path, title: str) -> None:
    text = session_path.read_text(encoding="utf-8")
    lines = text.split("\n")
    header = json.loads(lines[0])
    header["title"] = title
    lines[0] = json.dumps(header)
    session_path.write_text("\n".join(lines), encoding="utf-8")


async def _run_title_generation(
    session_path: Path,
    message: str,
    model: str,
    title_queue: asyncio.Queue,
    assistant_response: str | None = None,
) -> None:
    try:
        header = json.loads(session_path.read_text(encoding="utf-8").split("\n")[0])
        if header.get("title") not in LEGACY_DEFAULT_TITLES:
            return
        title = await generate_session_title(
            message, model=model, assistant_response=assistant_response,
        )
        header = json.loads(session_path.read_text(encoding="utf-8").split("\n")[0])
        if header.get("title") not in LEGACY_DEFAULT_TITLES:
            return
        if title in LEGACY_DEFAULT_TITLES:
            return
        _set_session_title(session_path, title)
        await title_queue.put({"type": "session_title", "title": title})
    except Exception:
        logger.warning("Session title generation task failed", exc_info=True)


def _parse_session_file(path: Path) -> dict | None:
    """Parse a JSONL session file into {meta, messages}."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        return None
    try:
        header = json.loads(lines[0])
    except json.JSONDecodeError:
        return None
    if header.get("type") != "header":
        return None

    messages = []
    updated_at = header.get("createdAt", "")
    for raw in lines[1:]:
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "user":
            messages.append({"role": "user", "content": entry.get("content", ""), "attachments": entry.get("attachments"), "chatImages": entry.get("chat_images")})
            updated_at = entry.get("timestamp", updated_at)
        elif entry.get("type") == "assistant":
            messages.append({
                "role": "assistant",
                "content": entry.get("content", ""),
                "steps": entry.get("steps"),
                "artifacts": entry.get("artifacts"),
            })
            updated_at = entry.get("timestamp", updated_at)

    return {
        "meta": {
            "sessionId": header["sessionId"],
            "projectDir": header.get("projectDir", ""),
            "title": header.get("title", DEFAULT_SESSION_TITLE),
            "createdAt": header.get("createdAt", ""),
            "updatedAt": updated_at,
            "messageCount": len(messages),
            "model": header.get("model"),
            "parentSessionId": header.get("parentSessionId"),
            "forkPointIndex": header.get("forkPointIndex"),
        },
        "messages": messages,
    }


def create_app(
    config_path: str | Path | None = None,
    cwd: str | Path | None = None,
    gui_static_dir: str | Path | None = None,
    multi_user: bool = False,
) -> FastAPI:
    """Build the FastAPI app with a ScoutAgent instance.

    Parameters
    ----------
    config_path : str | Path | None
        Path to the project config YAML (optional).
    cwd : str | Path | None
        Working directory for the agent (defaults to os.getcwd()).
    gui_static_dir : str | Path | None
        Path to pre-built GUI static files to serve (optional).
    """
    resolved_cwd = str(Path(cwd).resolve()) if cwd else _os.getcwd()
    resolved_config = str(Path(config_path).resolve()) if config_path else None
    workspace_root = resolved_cwd  # in multi-user mode, users/ and shared/ live under here

    app = FastAPI(title="Scout Agent Server", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    class SessionState:
        """Isolated state for a single user session."""
        def __init__(self, agent: ScoutAgent, model: str):
            self.agent = agent
            self.model = model
            self.approval_queue: asyncio.Queue | None = None
            self.approval_event: asyncio.Event | None = None
            self.approval_response: ApprovalResponse | None = None
            self.edit_done_event: asyncio.Event | None = None
            self.declined_this_turn = False
            self.auto_approve = False
            self.abort_event: asyncio.Event | None = None
            self.active_permission_profile: str | None = None

    # ── State (created on startup) ───────────────────────────────────
    _state: dict[str, Any] = {
        "sessions": {},    # (user_id, session_id) -> SessionState
        "retrievers": {},  # user_id (str) -> RetrieverProxy  (multi-user only)
        "grant_store": CapabilityGrantStore(),
        "config_path": resolved_config,
        "cwd": resolved_cwd,
        "workspace_root": workspace_root,
        "start_time": time.time(),
        "init_error": None,
        "multi_user": multi_user,
        "execution_health": None,
    }

    def _load_base_config() -> AppConfig:
        if _state["multi_user"] and _state["config_path"]:
            return load_deployment_config(_state["config_path"], cwd=_state["cwd"])
        return load_config(_state["config_path"], cwd=_state["cwd"])

    initial_config = _load_base_config()
    _state["base_config"] = initial_config
    _state["config_version"] = config_hash(initial_config)
    _state["config_reloaded_at"] = time.time()

    def _base_config_copy() -> AppConfig:
        return _state["base_config"].model_copy(deep=True)

    async def _probe_execution_sandbox() -> dict:
        """Probe the execution worker and refresh cached health/init state."""
        from ..config import ExecutionConfig
        from ..execution.worker_backend import WorkerExecutionBackend

        backend = WorkerExecutionBackend(ExecutionConfig())
        health = await backend.health()
        snapshot = {
            "available": health.available,
            "backend": health.backend,
            "isolation": health.isolation,
            "isolation_tier": health.isolation_tier,
            "persistent_python": health.persistent_python,
            "oneshot": health.oneshot,
            "worker_reachable": health.worker_reachable,
            "warnings": health.warnings,
            "error": health.error,
        }
        _state["execution_health"] = snapshot
        _state["last_exec_probe"] = time.time()
        if health.available and health.isolation:
            # Worker recovered (or finished booting) — clear the stale error.
            _state["init_error"] = None
        return snapshot

    @app.on_event("startup")
    async def _verify_execution_sandbox() -> None:
        """Fail closed in server mode when the execution worker is unavailable.

        Compose starts the worker and server concurrently, so the first probes
        can race the worker's boot — retry with backoff before declaring the
        sandbox unavailable.
        """
        if not multi_user:
            return
        snapshot: dict = {}
        for attempt in range(5):
            snapshot = await _probe_execution_sandbox()
            if snapshot["available"] and snapshot["isolation"]:
                return
            await asyncio.sleep(1.5 * (attempt + 1))
        _state["init_error"] = (
            snapshot.get("error")
            or "Execution worker unavailable or isolation probe failed"
        )
        logger.error("Server mode execution sandbox unavailable: %s", _state["init_error"])

    def _session_cwd(user_id: str | int) -> str:
        """Return the cwd to use for session storage and agent init."""
        if _state["multi_user"] and str(user_id) != "default":
            return str(user_workspace(_state["workspace_root"], user_id))
        return _state["cwd"]

    def _get_or_create_proxy(user_id: str | int) -> "RetrieverProxy | None":
        """Return the shared BM25 proxy for a user, creating it if needed."""
        if not _state["multi_user"]:
            return None
        uid = str(user_id)
        if uid not in _state["retrievers"]:
            personal = user_workspace(_state["workspace_root"], user_id)
            shared = shared_workspace(_state["workspace_root"])
            personal.mkdir(parents=True, exist_ok=True)
            shared.mkdir(parents=True, exist_ok=True)
            config = _base_config_copy()
            _state["retrievers"][uid] = RetrieverProxy(
                workspace_roots=[personal, shared],
                config=config,
            )
        return _state["retrievers"][uid]

    def _effective_config(personal: Path, user_id: str | int = "default") -> AppConfig:
        config = _base_config_copy()
        if _state["multi_user"] and str(user_id) != "default":
            preferences = get_user_memory_preferences(user_id)
            if preferences is not None:
                config.memories.use_memories = preferences["use_memories"]
                config.memories.generate_memories = preferences["generate_memories"]
        return config

    def _get_session_state(session_id: str, user_id: str | int = "default", user: User | None = None) -> SessionState:
        """Return the SessionState for a given ID, creating it if needed."""
        key = (str(user_id), session_id)
        if key not in _state["sessions"]:
            try:
                session_model = None
                session_path = _session_file(_session_cwd(user_id), session_id, user_id)
                if session_path.exists():
                    try:
                        session_model = json.loads(session_path.read_text(encoding="utf-8").splitlines()[0]).get("model")
                    except Exception:
                        pass
                if _state["multi_user"] and user is not None:
                    personal, shared = ensure_workspaces(_state["workspace_root"], user_id)
                    perm_profile = profile_from_user(
                        permission_profile=get_user_permission_profile(user_id),
                    )
                    guard = WorkspaceGuard(
                        personal_dir=personal,
                        shared_dir=shared,
                        allow_write_shared=perm_profile.allow_shared_write,
                    )
                    proxy = _get_or_create_proxy(user_id)
                    agent_config = _effective_config(personal, user_id)
                    if session_model:
                        agent_config.agent.model = session_model
                    agent = ScoutAgent(
                        config_path=_state["config_path"],
                        cwd=str(personal),
                        approval_callback=_approval_callback,
                        capability_approval_callback=_capability_approval_callback,
                        approval_callback_args=(session_id, user_id),
                        guard=guard,
                        retriever=proxy,
                        user_id=str(user_id),
                        session_id=session_id,
                        server_mode=_state["multi_user"],
                        shared_dir=shared,
                        grant_store=_state["grant_store"],
                        profile=perm_profile,
                        config=agent_config,
                    )
                else:
                    agent_config = _base_config_copy()
                    if session_model:
                        agent_config.agent.model = session_model
                    agent = ScoutAgent(
                        config_path=_state["config_path"],
                        cwd=_state["cwd"],
                        approval_callback=_approval_callback,
                        capability_approval_callback=_capability_approval_callback,
                        approval_callback_args=(session_id, user_id),
                        user_id=str(user_id),
                        session_id=session_id,
                        server_mode=False,
                        grant_store=_state["grant_store"],
                        config=agent_config,
                    )
                s = SessionState(agent, agent_config.agent.model)
                snap = load_session_snapshot(_session_dir(_session_cwd(user_id), user_id), session_id)
                if snap and snap.get("active_profile"):
                    s.active_permission_profile = snap["active_profile"]
                    agent.set_active_profile(snap["active_profile"])
                if snap and snap.get("grants"):
                    _state["grant_store"].import_session(
                        str(user_id), session_id, snap["grants"],
                    )
                if snap and snap.get("exec_rules") and agent._execution and agent._execution._orchestrator:
                    agent._execution._orchestrator._session_exec_rules = list(snap["exec_rules"])

                async def _req_perms(reason: str, domains: list[str]) -> str:
                    return await _permission_elevation_callback(
                        session_id, user_id, reason, domains,
                    )

                agent.set_request_permissions_fn(_req_perms)
                _state["sessions"][key] = s

                if _state["multi_user"] and user is not None:
                    personal, _ = ensure_workspaces(_state["workspace_root"], user.id)
                else:
                    personal = Path(_state["cwd"])
                cfg = _effective_config(personal, user_id)
                run_hook(
                    "SessionStart",
                    {"session_id": session_id, "user_id": str(user_id)},
                    personal_dir=personal,
                    server_mode=_state["multi_user"],
                    enabled=cfg.hooks.enabled,
                )
                if cfg.memories.generate_memories:
                    schedule_memory_pipeline(
                        session_id=session_id,
                        personal_dir=personal,
                        server_mode=_state["multi_user"],
                        sessions_dir=_session_dir(_session_cwd(user_id), user_id),
                        config=cfg,
                        user_id=str(user_id),
                    )
            except Exception as exc:
                logger.exception("Failed to initialize agent for session %s (user %s)", session_id, user_id)
                raise HTTPException(status_code=500, detail=str(exc))

        return _state["sessions"][key]

    # Helper to enforce auth if multi_user is True
    async def get_user_context(user: User | None = Depends(get_current_user_optional)):
        if _state["multi_user"] and not user:
            raise HTTPException(status_code=401, detail="Authentication required")
        return user

    # DB-backed admin gate — never trusts JWT claims
    async def require_admin(user: User | None = Depends(get_user_context)) -> User:
        if not user or not is_user_admin(user.id):
            raise HTTPException(status_code=403, detail="Admin privileges required")
        return user

    async def _approval_callback(
        session_id: str, user_id: str | int, tool_name: str, diffs: list, args: dict,
    ) -> tuple[str, str]:
        """Called by the graph's tool_node after execution detects file changes.

        Sends the actual diffs to the CLI for review.  Supports auto-decline
        (after first "no"), auto-approve (after "always"), and external
        editor (waits for CLI to finish editing before returning).
        """
        key = (str(user_id), session_id)
        s = _state["sessions"].get(key)
        if not s:
            return ("no", "Session expired")

        if s.declined_this_turn:
            return ("no", "")

        if s.auto_approve:
            return ("yes", "")

        # No queue means we're not in an SSE /chat flow (e.g. /init-skill).
        # Auto-approve since there's no UI to show the approval request.
        if s.approval_queue is None:
            return ("yes", "")

        approval_id = str(uuid.uuid4())

        diff_entries = []
        for d in diffs:
            diff_entries.append({
                "path": d.path,
                "status": d.status,
                "diff": d.diff[:2000],
            })

        kind = "execution_promotion" if tool_name == "execution_promotion" else "file_changes"
        event_data = {
            "type": "approval_request",
            "kind": kind,
            "approval_id": approval_id,
            "tool_name": tool_name,
            "diffs": diff_entries,
            "can_share": _state["multi_user"] and is_user_admin(user_id) and kind == "file_changes",
        }

        s.approval_event = asyncio.Event()
        s.approval_response = None

        await s.approval_queue.put(event_data)

        await s.approval_event.wait()

        resp: ApprovalResponse = s.approval_response
        s.approval_event = None
        s.approval_response = None

        if resp.action == "edit":
            # Wait for the CLI to finish editing and signal us
            s.edit_done_event = asyncio.Event()
            await s.edit_done_event.wait()
            s.edit_done_event = None

        elif resp.action == "shared":
            # Admin chose to move the written file(s) into the shared team repo.
            # Backend re-checks admin even if the client somehow sent this action.
            if is_user_admin(user_id):
                shared = shared_workspace(_state["workspace_root"])
                shared.mkdir(parents=True, exist_ok=True)
                moved: list[str] = []
                for d in diffs:
                    if d.status == "deleted":
                        continue
                    src = Path(d.path)
                    if src.exists():
                        dest = shared / src.name
                        if dest.exists():
                            dest.unlink()
                        shutil.move(str(src), str(dest))
                        moved.append(str(dest))
                note = ", ".join(moved) if moved else "(nothing to move)"
                # Shared dir changed — all users need a retriever rebuild
                for p in _state["retrievers"].values():
                    p.mark_dirty()
                return ("shared", note)
            # Non-admin somehow sent "shared" — treat as plain approve
            proxy = _state["retrievers"].get(str(user_id))
            if proxy:
                proxy.mark_dirty()
            return ("yes", "")

        if resp.action == "no":
            s.declined_this_turn = True
        elif resp.action == "always":
            s.auto_approve = True
            # Files were written — schedule a retriever rebuild for next search
            proxy = _state["retrievers"].get(str(user_id))
            if proxy:
                proxy.mark_dirty()
        elif resp.action == "yes":
            proxy = _state["retrievers"].get(str(user_id))
            if proxy:
                proxy.mark_dirty()

        return (resp.action, resp.feedback)

    async def _capability_approval_callback(
        session_id: str, user_id: str | int, cap: CapabilityRequest,
    ) -> tuple[str, str]:
        """Request user approval for a narrowly scoped capability."""
        key = (str(user_id), session_id)
        s = _state["sessions"].get(key)
        if not s or s.approval_queue is None:
            return ("deny", "No active approval channel")

        approval_id = str(uuid.uuid4())
        event_data = {
            "type": "approval_request",
            "kind": "capability",
            "approval_id": approval_id,
            "capability": {
                "capability": cap.capability,
                "reason": cap.reason,
                "scope": cap.scope,
                "command_summary": cap.command_summary,
            },
        }
        s.approval_event = asyncio.Event()
        s.approval_response = None
        await s.approval_queue.put(event_data)
        await s.approval_event.wait()
        resp: ApprovalResponse = s.approval_response
        s.approval_event = None
        s.approval_response = None
        if resp.action in {"deny", "no"}:
            return ("deny", resp.feedback)
        if resp.action == "allow_once":
            return ("allow_once", resp.feedback)
        if resp.action in {"allow_session", "always"}:
            if s.agent._execution and s.agent._execution._orchestrator:
                orch = s.agent._execution._orchestrator
                prefix = (resp.execpolicy_prefix or cap.command_summary or "").strip()
                if prefix:
                    if len(prefix) > 80:
                        parts = prefix.split(None, 2)
                        prefix = f"{parts[0]} " if parts else prefix[:40]
                    scope = resp.execpolicy_scope or ("always" if resp.save_execpolicy else "session")
                    if scope == "always":
                        orch.save_exec_rule(prefix, scope="always")
                    else:
                        orch.add_session_exec_rule(prefix)
            return ("allow_session", resp.feedback)
        return ("deny", resp.feedback)

    async def _permission_elevation_callback(
        session_id: str,
        user_id: str | int,
        reason: str,
        domains: list[str],
    ) -> str:
        key = (str(user_id), session_id)
        s = _state["sessions"].get(key)
        if not s or s.approval_queue is None:
            return "[REQUEST DENIED] No active approval channel."
        profile = s.agent._profile
        if not profile.can_request_permissions:
            return "[REQUEST DENIED] Your permission profile cannot request elevation."

        approval_id = str(uuid.uuid4())
        event_data = {
            "type": "approval_request",
            "kind": "permission_elevation",
            "approval_id": approval_id,
            "permission_request": {
                "reason": reason,
                "network_domains": domains,
            },
        }
        s.approval_event = asyncio.Event()
        s.approval_response = None
        await s.approval_queue.put(event_data)
        await s.approval_event.wait()
        resp: ApprovalResponse = s.approval_response
        s.approval_event = None
        s.approval_response = None
        if resp.action in {"deny", "no"}:
            return f"[REQUEST DENIED] {resp.feedback}".strip()

        if domains and s.agent._execution and s.agent._execution._orchestrator:
            cap = CapabilityRequest(
                capability="network_domain",
                reason=reason,
                scope={"domains": domains},
                command_summary="",
            )
            grant_id = str(uuid.uuid4())
            _state["grant_store"].add(
                grant_id, str(user_id), session_id,
                "network_domain", {"domains": domains}, grant_scope="session",
            )

        if resp.action in {"allow_session", "always"}:
            s.active_permission_profile = "admin"
            s.agent.set_active_profile("admin")
            return "Permissions elevated for this session (admin profile, network granted where requested)."
        return "Permissions granted for this request."

    @app.on_event("startup")
    async def _startup() -> None:
        if _state["multi_user"]:
            shared_workspace(_state["workspace_root"]).mkdir(parents=True, exist_ok=True)
        logger.info(
            "Scout server started in %s mode (cwd=%s)",
            "multi-user" if multi_user else "local",
            _state["cwd"],
        )

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        for s in _state["sessions"].values():
            await s.agent.close()

    # ── Endpoints ────────────────────────────────────────────────────

    @app.post("/api/register")
    async def register(req: dict):
        if not _state["multi_user"]:
            raise HTTPException(status_code=400, detail="Multi-user not enabled")
        username = req.get("username")
        password = req.get("password")
        if not username or not password:
            raise HTTPException(status_code=400, detail="Username and password required")
        user = create_user(username, password)
        if not user:
            raise HTTPException(status_code=400, detail="Username already registered")
        return {"status": "ok", "user": {"id": user["id"], "username": user["username"], "is_admin": bool(user.get("is_admin", False))}}

    @app.post("/api/login")
    async def login(req: dict):
        if not _state["multi_user"]:
            raise HTTPException(status_code=400, detail="Multi-user not enabled")
        username = req.get("username")
        password = req.get("password")
        user = get_user_by_username(username)
        if not user or not verify_password(password, user["hashed_password"]):
            raise HTTPException(status_code=401, detail="Incorrect username or password")
        
        access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        access_token = create_access_token(
            data={"sub": str(user["id"]), "username": user["username"]},
            expires_delta=access_token_expires
        )
        return {"access_token": access_token, "token_type": "bearer", "user": {"id": user["id"], "username": user["username"], "is_admin": bool(user.get("is_admin", False))}}

    @app.post("/chat")
    async def chat(req: ChatRequest, user: User | None = Depends(get_user_context)) -> EventSourceResponse:
        """Stream agent events as SSE."""
        uid = user.id if user else "default"
        s = _get_session_state(req.session_id, uid, user)
        agent = s.agent
        if s.abort_event is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "SESSION_BUSY",
                    "message": "This conversation already has a response in progress.",
                },
            )

        # Rebuild BM25 index for this user if files changed since last chat
        proxy = _get_or_create_proxy(uid)
        if proxy is not None:
            proxy.rebuild_if_dirty()

        agent.set_focus_from_attachments(req.attachments or None)

        # Build enriched message with attachment metadata
        message = req.message
        if req.attachments:
            notes = build_attachment_notes(req.attachments)
            if notes:
                message = f"{message}\n\n{notes}"

        logger.info("Chat request received (session %s): %s", req.session_id, message[:120])

        if _state["multi_user"] and user is not None:
            personal, _ = ensure_workspaces(_state["workspace_root"], user.id)
        else:
            personal = Path(_state["cwd"])
        cfg = _effective_config(personal, uid)
        sdir = _session_dir(_session_cwd(uid), uid)
        try:
            private_images = [str(p) for p in resolve_assets(sdir, req.session_id, req.chat_image_ids)]
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Chat image not found")
        images = image_paths(req.attachments) + private_images
        session_path = _session_file(_session_cwd(uid), req.session_id, uid)
        session_requires_vision = False
        if session_path.exists():
            try:
                session_requires_vision = any(
                    image_paths(json.loads(line).get("attachments")) or json.loads(line).get("chat_images")
                    for line in session_path.read_text(encoding="utf-8").splitlines()[1:]
                    if line.strip()
                )
            except Exception:
                logger.debug("Could not inspect session vision state", exc_info=True)
        overrides = getattr(cfg, "model_capabilities", None)
        overrides = overrides if isinstance(overrides, dict) else {}
        vision = model_vision_support(s.model, overrides)
        if (images or session_requires_vision) and vision != "supported":
            reason = "contains images" if session_requires_vision else "includes an image"
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "MODEL_VISION_REQUIRED",
                    "message": f"This conversation {reason} and requires a verified vision model.",
                    "model": s.model,
                    "vision": vision,
                },
            )
        run_hook(
            "UserPromptSubmit",
            {"session_id": req.session_id, "message": message[:500]},
            personal_dir=personal,
            server_mode=_state["multi_user"],
            enabled=cfg.hooks.enabled,
        )

        s.approval_queue = asyncio.Queue()
        s.declined_this_turn = False
        s.auto_approve = False
        s.abort_event = asyncio.Event()

        cwd = _session_cwd(uid)
        session_path = _session_file(cwd, req.session_id, uid)
        title_queue: asyncio.Queue = asyncio.Queue()
        title_task: asyncio.Task | None = None
        title_model = s.model
        if session_path.exists():
            try:
                header = json.loads(session_path.read_text(encoding="utf-8").split("\n")[0])
                if header.get("title") in LEGACY_DEFAULT_TITLES:
                    title_task = asyncio.create_task(
                        _run_title_generation(session_path, req.message, title_model, title_queue),
                    )
            except Exception:
                logger.debug("Could not schedule session title generation", exc_info=True)

        async def _generate():
            event_count = 0

            stream_task: asyncio.Task | None = None
            agent_events: asyncio.Queue = asyncio.Queue()
            first_assistant_response: str | None = None

            def session_event(payload: dict) -> dict:
                return {**payload, "session_id": req.session_id}

            async def retry_title_after_initial(response: str) -> None:
                if title_task:
                    try:
                        await title_task
                    except Exception:
                        pass
                await _run_title_generation(
                    session_path, req.message, title_model, asyncio.Queue(),
                    assistant_response=response,
                )

            event_count += 1
            yield ServerSentEvent(
                data=json.dumps(session_event({"type": "accepted"})),
                event="accepted",
            )

            async def _drain_agent():
                """Run agent.stream() and push events into agent_events queue."""
                try:
                    async for ev in agent.stream(message, images):
                        await agent_events.put(("event", ev))
                except Exception as exc:
                    await agent_events.put(("error", exc))
                finally:
                    await agent_events.put(("done", None))

            stream_task = asyncio.create_task(_drain_agent())
            approval_q: asyncio.Queue = s.approval_queue

            done = False
            try:
                while not done:
                    while True:
                        try:
                            title_event = title_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        event_count += 1
                        yield ServerSentEvent(
                            data=json.dumps(session_event(title_event)),
                            event="session_title",
                        )

                    agent_get = asyncio.ensure_future(agent_events.get())
                    approval_get = asyncio.ensure_future(approval_q.get())
                    abort_get = asyncio.ensure_future(s.abort_event.wait())

                    pending = {agent_get, approval_get, abort_get}
                    finished, still_pending = await asyncio.wait(
                        pending, return_when=asyncio.FIRST_COMPLETED,
                    )

                    for task in still_pending:
                        task.cancel()

                    for task in finished:
                        result = task.result()

                        if task is agent_get:
                            kind, payload = result
                            if kind == "event":
                                if payload.get("type") == "response" and payload.get("content"):
                                    first_assistant_response = payload["content"]
                                event_count += 1
                                logger.debug(
                                    "SSE event #%d: type=%s",
                                    event_count, payload.get("type"),
                                )
                                yield ServerSentEvent(
                                    data=json.dumps(session_event(payload)),
                                    event=payload["type"],
                                )
                            elif kind == "error":
                                exc = payload
                                if isinstance(exc, ProviderRateLimitError):
                                    logger.warning("Rate limit during streaming: %s", exc)
                                    yield ServerSentEvent(
                                        data=json.dumps(session_event({
                                            "type": "error",
                                            "message": f"Rate limit: {exc}",
                                            "retry_after": getattr(exc, "retry_after", None),
                                        })),
                                        event="error",
                                    )
                                else:
                                    logger.exception("Error during chat streaming: %s", exc)
                                    yield ServerSentEvent(
                                        data=json.dumps(session_event({
                                            "type": "error",
                                            "message": f"Server error: {exc}",
                                        })),
                                        event="error",
                                    )
                                done = True
                            elif kind == "done":
                                done = True

                        elif task is abort_get:
                            logger.info("Chat interrupted by user (session %s)", req.session_id)
                            yield ServerSentEvent(
                                data=json.dumps(session_event({"type": "error", "message": "Interrupted by user"})),
                                event="error",
                            )
                            done = True

                        elif task is approval_get:
                            approval_event = result
                            event_count += 1
                            logger.debug(
                                "SSE approval_request event #%d: %s",
                                event_count, approval_event.get("approval_id"),
                            )
                            yield ServerSentEvent(
                                data=json.dumps(session_event(approval_event)),
                                event="approval_request",
                            )

            finally:
                if first_assistant_response and session_path.exists():
                    asyncio.create_task(retry_title_after_initial(first_assistant_response))
                while True:
                    try:
                        title_event = title_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    event_count += 1
                    yield ServerSentEvent(
                        data=json.dumps(session_event(title_event)),
                        event="session_title",
                    )
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                s.approval_queue = None
                s.abort_event = None
                logger.info("SSE stream finished (%d events emitted)", event_count)

        return EventSourceResponse(_generate())

    @app.post("/chat/stop")
    async def stop_chat(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Interrupt an active agent execution."""
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s and s.abort_event:
            s.abort_event.set()
            return {"status": "ok", "message": "Interruption signaled"}
        return {"status": "ok", "message": "No active task to stop"}


    @app.get("/test-sse")
    async def test_sse() -> EventSourceResponse:
        """Debugging endpoint: stream a few test SSE events."""
        async def _gen():
            yield ServerSentEvent(
                data=json.dumps({"type": "tool_call", "name": "test", "args": {}}),
                event="tool_call",
            )
            await asyncio.sleep(0.2)
            yield ServerSentEvent(
                data=json.dumps({"type": "response", "content": "Hello from Scout!"}),
                event="response",
            )
        return EventSourceResponse(_gen())

    # Removed duplicate /reset route

    @app.post("/restore")
    async def restore(req: RestoreRequest, session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Restore agent conversation history from a persisted session."""
        uid = user.id if user else "default"
        s = _get_session_state(session_id, uid, user)
        agent = s.agent

        from langchain_core.messages import AIMessage, ToolMessage
        from ..agent.multimodal import build_human_message

        restored: list = []
        for idx, m in enumerate(req.messages):
            role = m.get("role", "")
            content = m.get("content", "")
            if role == "user":
                paths = list(m.get("attachments") or [])
                try:
                    paths.extend(str(p) for p in resolve_assets(
                        _session_dir(_session_cwd(uid), uid),
                        session_id,
                        [img["id"] for img in (m.get("chatImages") or [])],
                    ))
                except (FileNotFoundError, KeyError):
                    pass
                restored.append(build_human_message(content, paths))
            elif role == "assistant":
                steps = m.get("steps") or []
                if steps:
                    tool_calls = [
                        {
                            "name": s.get("name", "unknown"),
                            "args": s.get("args") or {},
                            "id": f"restore-{idx}-{j}",
                        }
                        for j, s in enumerate(steps)
                    ]
                    restored.append(AIMessage(content=content or "", tool_calls=tool_calls))
                    for j, s in enumerate(steps):
                        restored.append(ToolMessage(
                            content=str(s.get("output", ""))[:500],
                            name=s.get("name", "unknown"),
                            tool_call_id=f"restore-{idx}-{j}",
                        ))
                else:
                    restored.append(AIMessage(content=content))
        agent._messages = restored
        cwd = _session_cwd(uid)
        snap = load_session_snapshot(_session_dir(cwd, uid), session_id)
        if snap:
            if snap.get("active_profile"):
                s.active_permission_profile = snap["active_profile"]
                agent.set_active_profile(snap["active_profile"])
            if snap.get("grants"):
                _state["grant_store"].import_session(str(uid), session_id, snap["grants"])
            if snap.get("exec_rules") and agent._execution and agent._execution._orchestrator:
                agent._execution._orchestrator._session_exec_rules = list(snap["exec_rules"])
        logger.info("Restored %d messages into agent history", len(restored))
        return {"status": "ok", "count": len(restored)}

    @app.get("/health")
    async def health() -> dict:
        """Server health check including execution backend status."""
        uptime = time.time() - _state["start_time"]
        init_error = _state.get("init_error")

        exec_health: dict | None = _state.get("execution_health")
        for s in _state["sessions"].values():
            svc = s.agent.execution_service
            if svc:
                h = await svc.health()
                exec_health = {
                    "available": h.available,
                    "backend": h.backend,
                    "isolation": h.isolation,
                    "isolation_tier": h.isolation_tier,
                    "persistent_python": h.persistent_python,
                    "oneshot": h.oneshot,
                    "worker_reachable": h.worker_reachable,
                    "warnings": h.warnings,
                    "error": h.error,
                }
                _state["execution_health"] = exec_health
                break
        else:
            # No live session to ask — if the cached result is unhealthy,
            # re-probe (rate-limited) so a worker that booted late or came
            # back self-heals instead of staying "Offline" until restart.
            if (
                _state["multi_user"]
                and (exec_health is None or not exec_health.get("available"))
                and time.time() - _state.get("last_exec_probe", 0) > 5
            ):
                exec_health = await _probe_execution_sandbox()

        # Local mode is ready immediately (agent initializes lazily per session).
        if _state["multi_user"] or _state["sessions"] or not _state["multi_user"]:
            body: dict = {
                "status": "ok",
                "uptime_seconds": round(uptime, 1),
                "multi_user": _state["multi_user"],
                "config_version": _state["config_version"],
                "config_reloaded_at": _state["config_reloaded_at"],
            }
            if exec_health:
                body["execution"] = exec_health
            if _state["multi_user"]:
                if _state.get("init_error"):
                    body["status"] = "error"
                    body["error"] = _state["init_error"]
                elif exec_health and not exec_health.get("available"):
                    body["status"] = "degraded"
            return body
        elif init_error:
            return {
                "status": "error",
                "error": str(init_error),
                "uptime_seconds": round(uptime, 1),
            }
        else:
            return {
                "status": "starting",
                "uptime_seconds": round(uptime, 1),
            }

    @app.get("/admin/execution-health")
    async def execution_health(admin: User = Depends(require_admin)) -> dict:
        """Admin-only execution backend health and metrics."""
        metrics = {"worker_starts": 0, "timeouts": 0, "denied_capabilities": 0}
        health_info = None
        for s in _state["sessions"].values():
            svc = s.agent.execution_service
            if svc:
                h = await svc.health()
                health_info = {
                    "available": h.available,
                    "backend": h.backend,
                    "isolation": h.isolation,
                    "isolation_tier": h.isolation_tier,
                    "warnings": h.warnings,
                    "error": h.error,
                    "persistent_python": h.persistent_python,
                    "oneshot": h.oneshot,
                    "worker_reachable": h.worker_reachable,
                }
                metrics = svc.auditor.metrics
                break
        if health_info is None:
            cached = _state.get("execution_health")
            if cached:
                health_info = {
                    "available": cached.get("available", False),
                    "backend": cached.get("backend", "unknown"),
                    "isolation": cached.get("isolation", False),
                    "isolation_tier": cached.get("isolation_tier"),
                    "warnings": cached.get("warnings", []),
                    "error": cached.get("error"),
                    "persistent_python": cached.get("persistent_python", False),
                    "oneshot": cached.get("oneshot", False),
                    "worker_reachable": cached.get("worker_reachable", False),
                }
            else:
                from ..execution.local_backend import LocalSandboxBackend
                from ..config import ExecutionConfig
                backend = LocalSandboxBackend(ExecutionConfig())
                h = await backend.health()
                health_info = {
                    "available": h.available,
                    "backend": h.backend,
                    "isolation": h.isolation,
                    "warnings": h.warnings,
                    "error": h.error,
                }
        return {"execution": health_info, "metrics": metrics}

    @app.get("/admin/config/effective")
    async def admin_effective_config(admin: User = Depends(require_admin)) -> dict:
        config = _base_config_copy()
        source = "deployment_yaml" if _state["config_path"] else "defaults_and_global"
        return {
            "config": redacted_config(config),
            "source": source,
            "config_path": _state["config_path"],
            "version": _state["config_version"],
            "reloaded_at": _state["config_reloaded_at"],
            "applies_to": "new_conversations",
        }

    @app.post("/admin/config/reload")
    async def admin_reload_config(admin: User = Depends(require_admin)) -> dict:
        try:
            candidate = _load_base_config()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid configuration: {exc}") from exc
        candidate.llm.inject_env_vars()
        _state["base_config"] = candidate
        _state["config_version"] = config_hash(candidate)
        _state["config_reloaded_at"] = time.time()
        return {
            "status": "ok",
            "version": _state["config_version"],
            "reloaded_at": _state["config_reloaded_at"],
            "applies_to": "new_conversations",
        }

    # ── Warnings (set by Node launcher after sandbox check) ────────
    _startup_warnings: list[str] = []

    @app.post("/warnings")
    async def set_warnings(body: dict) -> dict:
        """Receive startup warnings from the Node launcher."""
        warnings = body.get("warnings", [])
        _startup_warnings.clear()
        _startup_warnings.extend(warnings)
        return {"status": "ok"}

    @app.get("/warnings")
    async def get_warnings() -> dict:
        """Return any startup warnings (e.g. sandbox unavailable)."""
        return {"warnings": _startup_warnings}

    @app.get("/config")
    async def get_config() -> dict:
        """Return the merged configuration."""
        config = _base_config_copy()
        return config.model_dump()

    @app.get("/config/models")
    async def get_models() -> dict:
        """Return all models aggregated from llm.providers."""
        config = _base_config_copy()
        models = config.llm.get_all_models()
        overrides = getattr(config, "model_capabilities", None)
        overrides = overrides if isinstance(overrides, dict) else {}
        return {
            "models": models,
            "capabilities": {m: {"vision": model_vision_support(m, overrides)} for m in models},
        }

    @app.post("/config/reload")
    async def reload_config() -> dict:
        if _state["multi_user"]:
            raise HTTPException(status_code=403, detail="Configuration disabled in server mode")
        """Re-read config from disk and re-inject env vars.

        Called after the user edits config.yaml externally.
        The running agent instance is NOT recreated — only env vars
        are refreshed so subsequent LLM calls pick up new keys.
        """
        config = _load_base_config()
        config.llm.inject_env_vars()
        _state["base_config"] = config
        _state["config_version"] = config_hash(config)
        _state["config_reloaded_at"] = time.time()
        return {"status": "ok", "models": config.llm.get_all_models()}

    @app.post("/config")
    async def set_config(req: ConfigSetRequest) -> dict:
        if _state["multi_user"]:
            raise HTTPException(status_code=403, detail="Configuration disabled in server mode")
        """Update a config value and persist it.

        The *scope* determines which config file is written to:
        - ``"project"`` → the project config file
        - ``"global"`` → ``~/.config/scout/config.yaml``
        """
        if req.scope == "global" or _state["config_path"] is None:
            target = GLOBAL_CONFIG_PATH
        else:
            target = Path(_state["config_path"])

        # Load existing YAML
        if target.exists():
            with open(target) as f:
                raw = yaml.safe_load(f) or {}
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            raw = {}

        # Navigate dotted key and set value
        keys = req.key.split(".")
        d = raw
        for k in keys[:-1]:
            if k not in d or not isinstance(d[k], dict):
                d[k] = {}
            d = d[k]
        d[keys[-1]] = req.value

        # Write back
        with open(target, "w") as f:
            yaml.safe_dump(raw, f, default_flow_style=False)

        logger.info("Config updated: %s = %s (scope=%s)", req.key, req.value, req.scope)
        return {"key": req.key, "value": req.value, "scope": req.scope, "file": str(target)}

    @app.post("/approval")
    async def approval(req: ApprovalResponse, session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Respond to a pending write-approval request."""
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if not s or s.approval_event is None:
            raise HTTPException(
                status_code=409,
                detail="No pending approval request for this session",
            )
        s.approval_response = req
        s.approval_event.set()
        return {"status": "ok", "approval_id": req.approval_id, "action": req.action}

    class EditDoneRequest(BaseModel):
        approval_id: str
        session_id: str

    @app.post("/edit-done")
    async def edit_done(req: EditDoneRequest, user: User | None = Depends(get_user_context)) -> dict:
        """Signal that the external editor has closed."""
        uid = user.id if user else "default"
        key = (str(uid), req.session_id)
        s = _state["sessions"].get(key)
        if not s or s.edit_done_event is None:
            raise HTTPException(
                status_code=409,
                detail="No pending edit session",
            )
        s.edit_done_event.set()
        return {"status": "ok", "approval_id": req.approval_id}

    @app.post("/reset")
    async def reset_agent(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Reset the agent's conversation history for a given session."""
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s:
            s.agent.reset()
            s.declined_this_turn = False
            s.auto_approve = False
        return {"status": "ok"}

    # ── Session management endpoints ────────────────────────────────

    @app.get("/sessions")
    async def list_sessions(user: User | None = Depends(get_user_context)) -> dict:
        """List all sessions for the current project."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        sdir = _session_dir(cwd, uid)
        if not sdir.is_dir():
            return {"sessions": []}

        sessions = []
        for f in sdir.iterdir():
            if f.suffix != ".jsonl":
                continue
            parsed = _parse_session_file(f)
            if parsed:
                sessions.append(parsed["meta"])

        sessions.sort(key=lambda s: s.get("updatedAt", ""), reverse=True)
        return {"sessions": sessions}

    @app.post("/sessions")
    async def create_session(model: str | None = None, user: User | None = Depends(get_user_context)) -> dict:
        """Create a new session and return its ID."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        session_id = str(uuid.uuid4())
        sdir = _session_dir(cwd, uid)
        sdir.mkdir(parents=True, exist_ok=True)

        header = {
            "type": "header",
            "sessionId": session_id,
            "projectDir": str(Path(cwd).resolve()),
            "createdAt": _now_iso(),
            "title": DEFAULT_SESSION_TITLE,
            "model": model,
        }
        path = _session_file(cwd, session_id, uid)
        path.write_text(json.dumps(header) + "\n", encoding="utf-8")
        return {"sessionId": session_id}

    @app.put("/sessions/{session_id}")
    async def ensure_session(session_id: str, model: str | None = None, user: User | None = Depends(get_user_context)) -> dict:
        """Idempotently register a caller-owned UUID as a server session."""
        try:
            uuid.UUID(session_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid session ID")
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        path = _session_file(cwd, session_id, uid)
        if not path.exists():
            sdir = _session_dir(cwd, uid)
            sdir.mkdir(parents=True, exist_ok=True)
            header = {
                "type": "header", "sessionId": session_id,
                "projectDir": str(Path(cwd).resolve()), "createdAt": _now_iso(),
                "title": DEFAULT_SESSION_TITLE, "model": model,
            }
            path.write_text(json.dumps(header) + "\n", encoding="utf-8")
        return {"sessionId": session_id}

    @app.get("/sessions/{session_id}")
    async def get_session(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Load a full session (meta + messages)."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        path = _session_file(cwd, session_id, uid)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Session not found")
        parsed = _parse_session_file(path)
        if not parsed:
            raise HTTPException(status_code=500, detail="Malformed session file")
        return parsed

    @app.put("/sessions/{session_id}/title")
    async def set_session_title(
        session_id: str,
        req: SessionTitleRequest,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Set a conversation title."""
        title = " ".join(req.title.split()).strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        if len(title) > 80:
            raise HTTPException(status_code=400, detail="Title must be 80 characters or fewer")
        uid = user.id if user else "default"
        path = _session_file(_session_cwd(uid), session_id, uid)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Session not found")
        _set_session_title(path, title)
        return {"title": title}

    @app.put("/sessions/{session_id}/model")
    async def set_session_model(
        session_id: str,
        req: SessionModelRequest,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Switch the model used by one conversation."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        path = _session_file(cwd, session_id, uid)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Session not found")
        personal = user_workspace(_state["workspace_root"], uid) if _state["multi_user"] and user else Path(_state["cwd"])
        config = _effective_config(personal, uid)
        if req.model not in config.llm.get_all_models():
            raise HTTPException(status_code=400, detail={"code": "UNKNOWN_MODEL", "message": "Model is not configured."})
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        header = json.loads(lines[0])
        header["model"] = req.model
        path.write_text("\n".join([json.dumps(header), *lines[1:]]) + "\n", encoding="utf-8")
        key = (str(uid), session_id)
        state = _state["sessions"].get(key)
        if state:
            state.agent.set_model(req.model)
            state.model = req.model
        else:
            state = _get_session_state(session_id, uid, user)
        overrides = getattr(config, "model_capabilities", None)
        overrides = overrides if isinstance(overrides, dict) else {}
        return {"model": state.model, "capabilities": {"vision": model_vision_support(state.model, overrides)}}

    @app.post("/sessions/{session_id}/chat-images")
    async def upload_chat_image(
        session_id: str,
        file: UploadFile = FAFile(...),
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Store a pasted image privately for one conversation."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        if not _session_file(cwd, session_id, uid).exists():
            raise HTTPException(status_code=404, detail="Session not found")
        data = await file.read(10 * 1024 * 1024 + 1)
        image_id = str(uuid.uuid4())
        try:
            meta = validate_and_store(data, _session_dir(cwd, uid), session_id, image_id)
        except ValueError as exc:
            raise HTTPException(status_code=415, detail=str(exc))
        return {**meta, "name": file.filename or "pasted-image", "url": f"/sessions/{session_id}/chat-images/{image_id}"}

    @app.get("/sessions/{session_id}/chat-images/{image_id}")
    async def get_chat_image(
        session_id: str,
        image_id: str,
        user: User | None = Depends(get_user_context),
    ):
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        if not _session_file(cwd, session_id, uid).exists():
            raise HTTPException(status_code=404, detail="Session not found")
        try:
            path = resolve_asset(_session_dir(cwd, uid), session_id, image_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Chat image not found")
        return FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable"})

    class ForkSessionRequest(BaseModel):
        from_message_index: int

    @app.post("/sessions/{session_id}/fork")
    async def fork_session(
        session_id: str,
        req: ForkSessionRequest,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Copy session history up to message index into a new branched session."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        parent_path = _session_file(cwd, session_id, uid)
        if not parent_path.exists():
            raise HTTPException(status_code=404, detail="Session not found")

        lines = [l for l in parent_path.read_text(encoding="utf-8").split("\n") if l.strip()]
        if not lines:
            raise HTTPException(status_code=500, detail="Malformed session file")

        try:
            parent_header = json.loads(lines[0])
        except json.JSONDecodeError:
            raise HTTPException(status_code=500, detail="Malformed session header")

        msg_lines = lines[1:]
        end = min(req.from_message_index + 1, len(msg_lines))
        if end < 0:
            raise HTTPException(status_code=400, detail="Invalid message index")

        new_id = str(uuid.uuid4())
        child_header = {
            "type": "header",
            "sessionId": new_id,
            "projectDir": parent_header.get("projectDir", str(Path(cwd).resolve())),
            "createdAt": _now_iso(),
            "title": f"Fork of {parent_header.get('title', 'session')}",
            "model": parent_header.get("model"),
            "parentSessionId": session_id,
            "forkPointIndex": req.from_message_index,
        }
        sdir = _session_dir(cwd, uid)
        sdir.mkdir(parents=True, exist_ok=True)
        child_path = _session_file(cwd, new_id, uid)
        child_content = json.dumps(child_header) + "\n"
        if end > 0:
            child_content += "\n".join(msg_lines[:end]) + "\n"
        child_path.write_text(child_content, encoding="utf-8")
        referenced_ids: set[str] = set()
        for raw in msg_lines[:end]:
            try:
                referenced_ids.update(img["id"] for img in json.loads(raw).get("chat_images", []))
            except Exception:
                pass
        for image_id in referenced_ids:
            try:
                source = resolve_asset(sdir, session_id, image_id)
                target_dir = asset_dir(sdir, new_id)
                target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(source, target_dir / source.name)
            except FileNotFoundError:
                pass
        copy_session_snapshot(sdir, session_id, new_id, parent_session_id=session_id)
        parent_grants = _state["grant_store"].export_session(str(uid), session_id)
        if parent_grants:
            _state["grant_store"].import_session(str(uid), new_id, parent_grants)
        parent_key = (str(uid), session_id)
        parent_state = _state["sessions"].get(parent_key)
        if parent_state and parent_state.agent._execution and parent_state.agent._execution._orchestrator:
            rules = list(parent_state.agent._execution._orchestrator._session_exec_rules)
            snap = load_session_snapshot(sdir, new_id) or {}
            snap["exec_rules"] = rules
            save_session_snapshot(
                sdir, new_id,
                grants=snap.get("grants", parent_grants),
                exec_rules=rules,
                active_profile=parent_state.active_permission_profile,
                parent_session_id=session_id,
            )
        return {"sessionId": new_id, "parentSessionId": session_id}

    @app.post("/sessions/{session_id}/messages")
    async def append_session_message(session_id: str, req: SessionMessageRequest, user: User | None = Depends(get_user_context)) -> dict:
        """Append a message to an existing session."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        path = _session_file(cwd, session_id, uid)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Session not found")

        entry: dict[str, Any] = {
            "type": req.role,
            "timestamp": _now_iso(),
            "content": req.content,
        }
        if req.role == "user" and req.attachments:
            entry["attachments"] = req.attachments
        if req.role == "user" and req.chat_images:
            entry["chat_images"] = req.chat_images
        if req.role == "assistant" and req.steps:
            entry["steps"] = req.steps
        if req.role == "assistant" and req.model:
            entry["model"] = req.model
        if req.role == "assistant" and req.artifacts:
            entry["artifacts"] = req.artifacts

        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

        return {"status": "ok"}

    @app.delete("/sessions/{session_id}")
    async def delete_session(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Delete a session."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        path = _session_file(cwd, session_id, uid)
        if path.exists():
            path.unlink()
        shutil.rmtree(asset_dir(_session_dir(cwd, uid), session_id), ignore_errors=True)
        # Clean up in-memory state and shut down the agent subprocess
        key = (str(uid), session_id)
        s = _state["sessions"].pop(key, None)
        if s:
            await s.agent.close()
        return {"status": "ok"}

    # ── File listing endpoint (for @ autocomplete) ───────────────────

    IGNORED_DIRS = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
        ".next", ".nuxt", ".scout", ".scout-cache", ".scout-executions",
        ".idea", ".vscode",
    }
    IGNORED_EXTENSIONS = {
        ".pyc", ".pyo", ".so", ".dylib", ".dll", ".o", ".a",
        ".class", ".jar", ".war", ".egg", ".whl",
    }

    from ..agent.file_guard import is_name_denied as _is_sandbox_denied

    def _fuzzy_file_score(candidate: str, query: str) -> int | None:
        """Return fuzzy score for a path query, or None if no match."""
        q = query.strip().lower()
        if not q:
            return 0

        c = candidate.lower()
        base_name = Path(candidate).name.lower()

        # Strong signals first
        if c.startswith(q):
            return 300 - min(len(candidate), 200)
        if base_name.startswith(q):
            return 260 - min(len(base_name), 200)
        if f"/{q}" in c:
            return 230 - min(len(candidate), 200)
        if q in c:
            return 200 - min(len(candidate), 200)

        # Subsequence match (fzf-like loose matching)
        pos = -1
        score = 120
        for ch in q:
            nxt = c.find(ch, pos + 1)
            if nxt < 0:
                return None
            gap = nxt - pos - 1
            if gap == 0:
                score += 6
            elif gap <= 2:
                score += 3
            else:
                score += 1
            pos = nxt

        # Prefer matches in basename and shorter paths
        if any(base_name[i : i + len(q)] == q for i in range(max(1, len(base_name) - len(q) + 1))):
            score += 20
        score -= min(len(candidate), 120) // 4
        return score

    @app.get("/files")
    async def list_files(
        prefix: str = Query("", description="Path prefix filter"),
        limit: int = Query(50, ge=1, le=200),
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """List workspace files for @-mention autocomplete.

        In multi-user mode, lists files from the user's personal workspace
        and the shared team repo, tagged with scope. In single-user mode,
        returns files from cwd with scope: null.
        """
        if _state["multi_user"] and user is not None:
            uid = user.id
            personal = user_workspace(_state["workspace_root"], uid)
            shared = shared_workspace(_state["workspace_root"])
            personal.mkdir(parents=True, exist_ok=True)
            shared.mkdir(parents=True, exist_ok=True)
            roots: list[tuple[Path, str | None]] = [(personal, "personal"), (shared, "shared")]
        else:
            roots = [(Path(_state["cwd"]), None)]

        matches: list[tuple[int, str, str | None, str]] = []  # (score, display, scope, abs_path)
        scan_limit = 30_000
        scanned = 0

        for root, scope in roots:
            for root_str, dirs, files in _os.walk(root):
                dirs[:] = [
                    d for d in dirs
                    if d not in IGNORED_DIRS and not d.startswith(".")
                ]
                root_path = Path(root_str)
                for fname in files:
                    ext = Path(fname).suffix.lower()
                    if ext in IGNORED_EXTENSIONS:
                        continue
                    if _is_sandbox_denied(fname):
                        continue
                    abs_path = str(root_path / fname)
                    try:
                        rel = str((root_path / fname).relative_to(root))
                    except ValueError:
                        rel = fname
                    score = _fuzzy_file_score(rel, prefix) if prefix else 0
                    if prefix and score is None:
                        continue
                    matches.append((score or 0, rel, scope, abs_path))
                    scanned += 1
                    if scanned >= scan_limit:
                        break
            if scanned >= scan_limit:
                break

        if prefix:
            matches.sort(key=lambda x: (-x[0], x[1]))
        else:
            matches.sort(key=lambda x: x[1])
        results = [
            {"path": m[1], "abs_path": m[3], "scope": m[2]}
            for m in matches[:limit]
        ]
        return {"files": results}

    @app.get("/files/content")
    async def file_content(
        path: str = Query(...),
        user: User | None = Depends(get_user_context),
    ):
        """Serve an image from an authorized workspace for previews."""
        candidate = Path(path).resolve()
        roots = (
            [user_workspace(_state["workspace_root"], user.id), shared_workspace(_state["workspace_root"])]
            if _state["multi_user"] and user is not None
            else [Path(_state["cwd"])]
        )
        if not any(candidate == root.resolve() or root.resolve() in candidate.parents for root in roots):
            raise HTTPException(status_code=403, detail="Path is outside the workspace")
        if not candidate.is_file() or not image_paths([str(candidate)]):
            raise HTTPException(status_code=404, detail="Image not found")
        return FileResponse(candidate, headers={"Cache-Control": "no-store, max-age=0"})

    @app.get("/artifacts/content")
    async def artifact_content(
        path: str = Query(...),
        user: User | None = Depends(get_user_context),
    ):
        """Serve a supported workspace artifact from an authorized root."""
        roots: list[Path]
        if _state["multi_user"] and user is not None:
            roots = [
                user_workspace(_state["workspace_root"], user.id),
                shared_workspace(_state["workspace_root"]),
            ]
        else:
            roots = [Path(_state["cwd"])]

        for root in roots:
            root = root.resolve()
            target = (root / path).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                continue
            if target.is_file() and not any(part.startswith(".") for part in target.relative_to(root).parts):
                if target.suffix.lower() not in RENDERERS or target.stat().st_size > MAX_ARTIFACT_SIZE:
                    raise HTTPException(status_code=415, detail="Unsupported artifact")
                return FileResponse(
                    target,
                    headers={"Cache-Control": "no-store, max-age=0"},
                )
        raise HTTPException(status_code=404, detail="Artifact not found")

    # ── Upload endpoint ──────────────────────────────────────────────

    @app.post("/upload")
    async def upload_file(
        file: UploadFile = FAFile(...),
        target: str = Query("personal"),
        user: User | None = Depends(get_user_context),
    ) -> dict:
        if not _state["multi_user"]:
            raise HTTPException(status_code=400, detail="Only available in multi-user mode")
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        if target == "shared":
            if not is_user_admin(user.id):
                raise HTTPException(status_code=403, detail="Only admins can upload to shared")
            dest_dir = shared_workspace(_state["workspace_root"])
        else:
            dest_dir = user_workspace(_state["workspace_root"], user.id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        fname = Path(file.filename or "upload").name
        if not fname or fname.startswith("."):
            raise HTTPException(status_code=400, detail="Invalid filename")
        dest = dest_dir / fname
        content = await file.read()
        dest.write_bytes(content)
        # Mark retriever(s) dirty so next search reflects the new file
        if target == "shared":
            for p in _state["retrievers"].values():
                p.mark_dirty()
        else:
            proxy = _state["retrievers"].get(str(user.id))
            if proxy:
                proxy.mark_dirty()
        return {"status": "ok", "filename": fname, "size": len(content)}

    # ── Shared repo management endpoints ────────────────────────────

    @app.get("/shared/files")
    async def list_shared_files(user: User | None = Depends(get_user_context)) -> dict:
        if not _state["multi_user"]:
            raise HTTPException(status_code=400, detail="Only available in multi-user mode")
        shared = shared_workspace(_state["workspace_root"])
        shared.mkdir(parents=True, exist_ok=True)
        files = [
            {"path": str(f.relative_to(shared)), "size": f.stat().st_size}
            for f in shared.rglob("*") if f.is_file()
        ]
        return {"files": files}

    @app.delete("/shared/files")
    async def delete_shared_file(
        path: str = Query(...),
        user: User = Depends(require_admin),
    ) -> dict:
        if not _state["multi_user"]:
            raise HTTPException(status_code=400, detail="Only available in multi-user mode")
        shared = shared_workspace(_state["workspace_root"]).resolve()
        target = (shared / path).resolve()
        if not str(target).startswith(str(shared)):
            raise HTTPException(status_code=400, detail="Path escapes shared workspace")
        if not target.exists():
            raise HTTPException(status_code=404, detail="File not found")
        target.unlink()
        # Shared dir changed — all users need a retriever rebuild
        for p in _state["retrievers"].values():
            p.mark_dirty()
        return {"status": "ok"}

    # ── Admin user management endpoints ─────────────────────────────

    @app.get("/admin/users")
    async def admin_list_users(user: User = Depends(require_admin)) -> dict:
        return {"users": list_users()}

    @app.patch("/admin/users/{uid}/role")
    async def admin_set_role(uid: int, body: dict, user: User = Depends(require_admin)) -> dict:
        new_role = bool(body.get("is_admin", False))
        if not new_role and uid == user.id:
            admins = [u for u in list_users() if u["permission_profile"] == "admin"]
            if len(admins) <= 1:
                raise HTTPException(status_code=400, detail="Cannot demote the only remaining admin")
        if not set_user_admin(uid, new_role):
            raise HTTPException(status_code=404, detail="User not found")
        return {"status": "ok"}

    @app.patch("/admin/users/{uid}/profile")
    async def admin_set_profile(uid: int, body: dict, user: User = Depends(require_admin)) -> dict:
        profile = str(body.get("permission_profile", ""))
        if profile not in ("analyst", "contributor", "admin"):
            raise HTTPException(status_code=400, detail="Invalid permission_profile")
        if profile != "admin" and uid == user.id:
            admins = [u for u in list_users() if u["permission_profile"] == "admin"]
            if len(admins) <= 1:
                raise HTTPException(status_code=400, detail="Cannot demote the only remaining admin")
        if not set_user_permission_profile(uid, profile):
            raise HTTPException(status_code=404, detail="User not found")
        return {"status": "ok"}

    # ── User memories ───────────────────────────────────────────────

    def _personal_dir_for_user(user: User | None) -> Path | None:
        if _state["multi_user"] and user is not None:
            personal, _ = ensure_workspaces(_state["workspace_root"], user.id)
            return personal
        return Path(_state["cwd"])

    @app.get("/memories")
    async def get_memories(user: User | None = Depends(get_user_context)) -> dict:
        uid = user.id if user else "default"
        personal = _personal_dir_for_user(user)
        return {
            "content": load_memory_registry(uid, personal, _state["multi_user"]),
            "entries": list_memory_entries(uid, personal, _state["multi_user"]),
            "summary": load_memory_summary(uid, personal, _state["multi_user"]),
        }

    @app.get("/memories/summary")
    async def get_memory_summary(user: User | None = Depends(get_user_context)) -> dict:
        uid = user.id if user else "default"
        personal = _personal_dir_for_user(user)
        return {"summary": load_memory_summary(uid, personal, _state["multi_user"])}

    @app.get("/memories/registry")
    async def get_memory_registry(user: User | None = Depends(get_user_context)) -> dict:
        uid = user.id if user else "default"
        personal = _personal_dir_for_user(user)
        return {
            "registry": load_memory_registry(uid, personal, _state["multi_user"]),
            "entries": list_memory_entries(uid, personal, _state["multi_user"]),
        }

    class MemoriesRequest(BaseModel):
        content: str = ""
        entry: str = ""
        remove_index: int | None = None
        summary: str | None = None

    class MemoryPreferencesRequest(BaseModel):
        use_memories: bool
        generate_memories: bool

    def _memory_preferences_response(user: User | None) -> dict:
        defaults = _base_config_copy().memories
        stored = (
            get_user_memory_preferences(user.id)
            if _state["multi_user"] and user is not None
            else None
        )
        effective = stored or {
            "use_memories": defaults.use_memories,
            "generate_memories": defaults.generate_memories,
        }
        inherited = stored is None
        return {
            **effective,
            "defaults": {
                "use_memories": defaults.use_memories,
                "generate_memories": defaults.generate_memories,
            },
            "inherited": {
                "use_memories": inherited,
                "generate_memories": inherited,
            },
            "applies_to": "new_conversations",
        }

    @app.get("/memories/preferences")
    async def get_memory_preferences(user: User | None = Depends(get_user_context)) -> dict:
        return _memory_preferences_response(user)

    @app.put("/memories/preferences")
    async def put_memory_preferences(
        req: MemoryPreferencesRequest,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        if _state["multi_user"]:
            if user is None:
                raise HTTPException(status_code=401, detail="Authentication required")
            set_user_memory_preferences(
                user.id,
                use_memories=req.use_memories,
                generate_memories=req.generate_memories,
            )
        else:
            target = GLOBAL_CONFIG_PATH
            if target.exists():
                with open(target) as f:
                    raw = yaml.safe_load(f) or {}
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                raw = {}
            memories = raw.setdefault("memories", {})
            memories["use_memories"] = req.use_memories
            memories["generate_memories"] = req.generate_memories
            with open(target, "w") as f:
                yaml.safe_dump(raw, f, sort_keys=False)
        return _memory_preferences_response(user)

    @app.post("/memories")
    async def post_memories(req: MemoriesRequest, user: User | None = Depends(get_user_context)) -> dict:
        uid = user.id if user else "default"
        personal = _personal_dir_for_user(user)
        if req.summary is not None:
            save_memory_summary(req.summary, uid, personal, _state["multi_user"])
        if req.remove_index is not None:
            content = remove_memory(req.remove_index, uid, personal, _state["multi_user"])
        elif req.entry.strip():
            content = add_memory(req.entry, uid, personal, _state["multi_user"])
        elif req.content:
            save_memory_registry(req.content, uid, personal, _state["multi_user"])
            content = req.content
        else:
            content = load_memory_registry(uid, personal, _state["multi_user"])
        return {
            "content": content,
            "entries": list_memory_entries(uid, personal, _state["multi_user"]),
            "summary": load_memory_summary(uid, personal, _state["multi_user"]),
        }

    # ── Init / workspace skill endpoints ────────────────────────────

    SKILL_SKIP_DIRS = {
        "node_modules", "__pycache__", ".git", ".venv", "env", "venv",
        ".egg-info", "dist", "build", ".tox", ".mypy_cache",
        ".pytest_cache", ".next", ".nuxt", ".idea", ".vscode",
    }

    def _walk_dir_shallow(root: Path, depth: int = 0, max_depth: int = 2) -> list[str]:
        """Walk directory tree to generate a file listing (like the CLI's walkDirShallow)."""
        if depth > max_depth:
            return []
        lines: list[str] = []
        try:
            for entry in sorted(root.iterdir()):
                name = entry.name
                if name.startswith(".") and name != ".scout":
                    continue
                if name in SKILL_SKIP_DIRS:
                    continue
                indent = "  " * depth
                if entry.is_dir():
                    lines.append(f"{indent}{name}/")
                    lines.extend(_walk_dir_shallow(entry, depth + 1, max_depth))
                else:
                    lines.append(f"{indent}{name}")
                if len(lines) > 200:
                    break
        except PermissionError:
            pass
        return lines

    def _skills_dir() -> Path:
        return Path(_state["cwd"]) / ".scout" / "skills"

    def _workspace_skill_path() -> Path:
        return _skills_dir() / "workspace.md"

    @app.get("/init-status")
    async def init_status() -> dict:
        if _state["multi_user"]:
            raise HTTPException(status_code=403, detail="Not available in server mode")
        """Check if workspace skill exists and return its content."""
        path = _workspace_skill_path()
        if path.exists():
            try:
                content = path.read_text(encoding="utf-8")
                return {"exists": True, "content": content}
            except OSError:
                return {"exists": False, "content": ""}
        return {"exists": False, "content": ""}

    @app.post("/init-skill")
    async def init_skill(req: InitSkillRequest, session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        if _state["multi_user"]:
            raise HTTPException(status_code=403, detail="Not available in server mode")
        """Generate a workspace skill file using the LLM."""
        s = _get_session_state(session_id)
        agent = s.agent

        listing = req.directory_summary
        if not listing or listing.startswith("(auto"):
            lines = _walk_dir_shallow(Path(_state["cwd"]))
            listing = "\n".join(lines) if lines else "(empty directory)"

        prompt = (
            "You are a workspace analyst. Given the following directory "
            "listing of a user's project, write a concise Markdown skill "
            "file (max ~60 lines) that:\n"
            "1. Describes the project and its key data files\n"
            "2. Lists analysis approaches and suggested workflows\n"
            "3. Notes any domain-specific conventions\n\n"
            "Use headings, bullet points, and code snippets where useful. "
            "Only describe what you can infer from the file listing — do "
            "not invent files that aren't listed.\n\n"
            "## Directory Listing\n\n"
            f"```\n{listing}\n```"
        )
        try:
            reply = await agent.chat(prompt)
            agent.reset()
            return {"content": reply}
        except Exception as exc:
            logger.exception("Error generating skill")
            raise HTTPException(status_code=500, detail=str(exc))

    @app.post("/init-save")
    async def init_save(req: SaveSkillRequest) -> dict:
        if _state["multi_user"]:
            raise HTTPException(status_code=403, detail="Not available in server mode")
        """Save workspace skill content to .scout/skills/workspace.md."""
        skills = _skills_dir()
        skills.mkdir(parents=True, exist_ok=True)
        path = _workspace_skill_path()
        path.write_text(req.content, encoding="utf-8")
        logger.info("Saved workspace skill to %s", path)
        return {"status": "ok", "path": str(path)}

    # Mount GUI static files (must be last — catches all unmatched routes)
    if gui_static_dir:
        gui_path = Path(gui_static_dir)
        if gui_path.is_dir():
            from starlette.staticfiles import StaticFiles

            app.mount("/", StaticFiles(directory=str(gui_path), html=True))
            logger.info("Serving GUI from %s", gui_path)
        else:
            logger.warning("GUI static dir not found: %s", gui_path)

    return app
