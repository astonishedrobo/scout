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
import base64
import hashlib
import json
import logging
import os as _os
import re
import shutil
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import Depends, FastAPI, HTTPException, Query, UploadFile, File as FAFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from ..execution.grants import CapabilityGrantStore
from ..task_store import TaskStore
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
from .attachments import build_attachment_notes
from ..media import image_paths
from ..model_capabilities import model_vision_support
from ..chat_images import asset_dir, resolve_asset, resolve_assets, validate_and_store
from .auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    User,
    create_access_token,
    create_user,
    get_current_user,
    get_current_user_optional,
    get_user_admission_group,
    get_user_memory_preferences,
    get_user_by_username,
    get_user_permission_profile,
    is_user_admin,
    list_users,
    set_user_admin,
    set_user_admission_group,
    set_user_memory_preferences,
    set_user_permission_profile,
    verify_password,
)
from .admission import (
    AdmissionPolicy,
    AdmissionRejected,
    AdmissionTimedOut,
    AgentTurnScheduler,
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
    fallback_title,
    generate_session_title,
)
from .workspace import (
    WorkspacePathError,
    ensure_workspaces,
    list_workspace_directory,
    location_for_scope,
    search_workspace_files,
    shared_workspace,
    user_workspace,
    workspace_locations,
    resolve_workspace_path,
)
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


APPROVAL_MODES = frozenset({"ask_always", "allow_edits", "full_access"})
DEFAULT_APPROVAL_MODE = "ask_always"


class SessionApprovalModeRequest(BaseModel):
    mode: str


def approval_required(mode: str, kind: str) -> bool:
    """Return whether an allowed action needs an interactive decision."""
    normalized = mode if mode in APPROVAL_MODES else DEFAULT_APPROVAL_MODE
    if normalized == "full_access":
        return False
    if normalized == "allow_edits" and kind in {"file_changes", "execution_promotion"}:
        return False
    return True


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
    file_changes: list[dict] | None = None
    chat_images: list[dict] | None = None
    annotations: list[dict] | None = None
    stopped: bool | None = None


# ── Session store helpers (matches Node.js JSONL format) ─────────────────

SESSIONS_ROOT = Path.home() / ".config" / "scout" / "sessions"
_SESSION_META_CACHE_MAX = 2048
_session_meta_cache: OrderedDict[Path, tuple[int, int, dict | None]] = OrderedDict()
_session_meta_cache_lock = threading.Lock()
_session_file_locks = tuple(threading.RLock() for _ in range(64))


def _session_file_lock(path: Path) -> threading.RLock:
    return _session_file_locks[hash(str(path.resolve())) % len(_session_file_locks)]

def _project_hash(cwd: str) -> str:
    return hashlib.sha256(str(Path(cwd).resolve()).encode()).hexdigest()[:12]

def _session_dir(cwd: str, user_id: str | int = "default") -> Path:
    return SESSIONS_ROOT / str(user_id) / _project_hash(cwd)

def _session_file(cwd: str, session_id: str, user_id: str | int = "default") -> Path:
    return _session_dir(cwd, user_id) / f"{session_id}.jsonl"

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _set_session_title(session_path: Path, title: str) -> None:
    _update_session_header(session_path, title=title)


def _update_session_header(session_path: Path, **updates: Any) -> dict:
    from ..atomic_io import atomic_write_text

    with _session_file_lock(session_path):
        text = session_path.read_text(encoding="utf-8")
        lines = text.split("\n")
        header = json.loads(lines[0])
        header.update(updates)
        lines[0] = json.dumps(header)
        atomic_write_text(session_path, "\n".join(lines))
        return header


def _append_session_entry(session_path: Path, entry: dict[str, Any]) -> None:
    with _session_file_lock(session_path):
        with session_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")


def _read_session_header(session_path: Path) -> dict:
    with _session_file_lock(session_path):
        with session_path.open(encoding="utf-8") as handle:
            return json.loads(handle.readline())


def _title_context(session_path: Path, assistant_response: str | None = None) -> dict:
    parsed = _parse_session_file(session_path)
    messages = parsed["messages"] if parsed else []
    first_user = next((m for m in messages if m["role"] == "user"), {})
    first_assistant = assistant_response or next(
        (m["content"] for m in messages if m["role"] == "assistant" and m.get("content")), ""
    )
    attachments = list(first_user.get("attachments") or [])
    chat_images = list(first_user.get("chatImages") or [])
    return {
        "message": first_user.get("content", ""),
        "assistant_response": first_assistant,
        "has_images": bool(chat_images or image_paths(attachments)),
        "attachment_names": [Path(p).name for p in attachments],
    }


async def _run_title_job(
    session_path: Path,
    model: str,
    assistant_response: str | None = None,
    timeout_seconds: int = 60,
    max_attempts: int = 2,
    client_kwargs: dict[str, str] | None = None,
) -> None:
    try:
        header = await asyncio.to_thread(_read_session_header, session_path)
        if header.get("title") not in LEGACY_DEFAULT_TITLES:
            return
        context = await asyncio.to_thread(_title_context, session_path, assistant_response)
        await asyncio.to_thread(
            _update_session_header,
            session_path, titleGenerationStatus="pending",
            titleGenerationAttempts=0, titleGenerationLastError=None,
        )
        title = DEFAULT_SESSION_TITLE
        for attempt in range(1, max_attempts + 1):
            await asyncio.to_thread(
                _update_session_header, session_path, titleGenerationAttempts=attempt
            )
            title = await generate_session_title(
                context["message"], model=model,
                assistant_response=context["assistant_response"],
                timeout_seconds=timeout_seconds,
                client_kwargs=client_kwargs,
            )
            if title not in LEGACY_DEFAULT_TITLES:
                break
            logger.info("Session title attempt %d/%d failed", attempt, max_attempts)
        header = await asyncio.to_thread(_read_session_header, session_path)
        if header.get("title") not in LEGACY_DEFAULT_TITLES:
            return
        if title in LEGACY_DEFAULT_TITLES:
            title = fallback_title(**context)
            logger.info("Using deterministic session title fallback: %s", title)
        await asyncio.to_thread(
            _update_session_header,
            session_path, title=title, titleGenerationStatus="completed",
            titleGenerationLastError=None,
        )
        logger.info("Session title updated: %s", title)
    except Exception as exc:
        if session_path.exists():
            await asyncio.to_thread(
                _update_session_header,
                session_path, titleGenerationStatus="failed",
                titleGenerationLastError=type(exc).__name__,
            )
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
    task_indexes: dict[str, int] = {}
    updated_at = header.get("createdAt", "")
    for raw in lines[1:]:
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "user":
            messages.append({"role": "user", "content": entry.get("content", ""), "attachments": entry.get("attachments"), "chatImages": entry.get("chat_images"), "annotations": entry.get("annotations")})
            updated_at = entry.get("timestamp", updated_at)
        elif entry.get("type") == "assistant":
            messages.append({
                "role": "assistant",
                "content": entry.get("content", ""),
                "steps": entry.get("steps"),
                "artifacts": entry.get("artifacts"),
                "fileChanges": entry.get("file_changes"),
                **({"stopped": True} if entry.get("stopped") else {}),
            })
            updated_at = entry.get("timestamp", updated_at)
        elif entry.get("type") == "task" and isinstance(entry.get("task"), dict):
            task = entry["task"]
            task_id = str(task.get("task_id") or "")
            message = {
                "role": "system",
                "content": "",
                "task": task,
            }
            if task_id and task_id in task_indexes:
                messages[task_indexes[task_id]] = message
            else:
                task_indexes[task_id] = len(messages)
                messages.append(message)
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
            "titleGenerationStatus": header.get("titleGenerationStatus"),
        },
        "messages": messages,
    }


def _parse_session_meta(path: Path) -> dict | None:
    """Read only session-list metadata, cached until the JSONL file changes."""
    try:
        stat = path.stat()
    except OSError:
        return None
    cache_key = path.resolve()
    signature = (stat.st_mtime_ns, stat.st_size)
    with _session_meta_cache_lock:
        cached = _session_meta_cache.get(cache_key)
        if cached and cached[:2] == signature:
            _session_meta_cache.move_to_end(cache_key)
            return dict(cached[2]) if cached[2] is not None else None

    meta: dict | None = None
    try:
        with path.open(encoding="utf-8") as handle:
            first = handle.readline()
            header = json.loads(first)
            if header.get("type") != "header":
                raise ValueError("not a session header")
            updated_at = header.get("createdAt", "")
            message_count = 0
            for raw in handle:
                if not raw.strip():
                    continue
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") in {"user", "assistant"}:
                    message_count += 1
                    updated_at = entry.get("timestamp", updated_at)
            meta = {
                "sessionId": header["sessionId"],
                "projectDir": header.get("projectDir", ""),
                "title": header.get("title", DEFAULT_SESSION_TITLE),
                "createdAt": header.get("createdAt", ""),
                "updatedAt": updated_at,
                "messageCount": message_count,
                "model": header.get("model"),
                "parentSessionId": header.get("parentSessionId"),
                "forkPointIndex": header.get("forkPointIndex"),
                "titleGenerationStatus": header.get("titleGenerationStatus"),
            }
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        meta = None

    with _session_meta_cache_lock:
        _session_meta_cache[cache_key] = (*signature, dict(meta) if meta is not None else None)
        _session_meta_cache.move_to_end(cache_key)
        while len(_session_meta_cache) > _SESSION_META_CACHE_MAX:
            _session_meta_cache.popitem(last=False)
    return meta


def _list_session_metadata(session_dir: Path) -> list[dict]:
    sessions = [
        meta
        for path in session_dir.iterdir()
        if path.suffix == ".jsonl" and (meta := _parse_session_meta(path)) is not None
    ]
    sessions.sort(key=lambda session: session.get("updatedAt", ""), reverse=True)
    return sessions


def _hash_file(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _decode_change_content(value: str | None) -> bytes | None:
    if value is None:
        return None
    return base64.b64decode(value.encode("ascii"), validate=True)


def _safe_workspace_file(root: Path, rel_path: str) -> Path:
    if not rel_path or Path(rel_path).is_absolute():
        raise HTTPException(status_code=400, detail="Invalid file path in change set")
    target = (root / rel_path).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Change set path escapes workspace")
    return target


def _find_stored_change_set(session_path: Path, change_set_id: str) -> tuple[dict, list[str], int, int]:
    lines = session_path.read_text(encoding="utf-8").splitlines()
    for line_index, raw in enumerate(lines):
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if entry.get("type") != "assistant":
            continue
        for set_index, change_set in enumerate(entry.get("file_changes") or []):
            if change_set.get("id") == change_set_id:
                return change_set, lines, line_index, set_index
    raise HTTPException(status_code=404, detail="Change set not found")


def _mark_change_set_undone(lines: list[str], line_index: int, set_index: int, session_path: Path) -> None:
    entry = json.loads(lines[line_index])
    entry["file_changes"][set_index]["undone"] = True
    lines[line_index] = json.dumps(entry)
    session_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
        def __init__(self, agent: Any, model: str):
            self.agent = agent
            self.model = model
            self.approval_queue: asyncio.Queue | None = None
            self.approval_event: asyncio.Event | None = None
            self.approval_response: ApprovalResponse | None = None
            self.edit_done_event: asyncio.Event | None = None
            self.declined_this_turn = False
            # Approval policy is independent of the user's authorization role.
            # It persists across turns and controls prompts, never hard denies.
            self.approval_mode = DEFAULT_APPROVAL_MODE
            self.pending_approval_id: str | None = None
            self.pending_approval_diffs: list[Any] = []
            # Only one approval card can be active for a session. Serialize
            # parent and worker requests so they cannot overwrite each other.
            self.approval_lock = asyncio.Lock()
            self.abort_event: asyncio.Event | None = None
            self.active_permission_profile: str | None = None
            self.created_at = time.monotonic()
            self.last_activity = self.created_at
            self.requires_vision = False
            # Auto-continue when a background sub-agent finishes while idle.
            self.auto_continue_task: asyncio.Task | None = None
            self.auto_continue_pending: bool = False
            # Fan-out for sub-agent / session UI events (SSE subscribers).
            self.event_subscribers: list[asyncio.Queue] = []
            # Ordered, bounded replay log.  A browser reconnect must be able to
            # catch up from an event id instead of relying on polling a stale
            # task snapshot.
            self.event_sequence = 0
            self.event_history: list[dict] = []
            self.task_store: TaskStore | None = None
            self.terminal_tasks: dict[int, asyncio.Task] = {}
            # Local, bounded timing history.  This is intentionally per
            # session: it helps diagnose perceived slowness without exporting
            # prompts or user activity into global telemetry.
            self.turn_metrics: list[dict[str, Any]] = []
            # Approvals while no /chat stream is open (background sub-agents).
            self.idle_approval_queue: asyncio.Queue = asyncio.Queue()

        def touch(self) -> None:
            self.last_activity = time.monotonic()

        @property
        def is_busy(self) -> bool:
            return self.abort_event is not None

        def broadcast_event(self, event: dict) -> None:
            self.event_sequence += 1
            event = {**event, "event_id": self.event_sequence}
            self.event_history.append(event)
            if len(self.event_history) > 512:
                del self.event_history[:-512]
            dead: list[asyncio.Queue] = []
            for q in self.event_subscribers:
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        q.put_nowait(event)
                    except asyncio.QueueFull:
                        dead.append(q)
            for q in dead:
                if q in self.event_subscribers:
                    self.event_subscribers.remove(q)

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
        "title_tasks": {},
        "maintenance_tasks": [],
        "session_init_locks": {},
        "session_init_reservations": set(),
        "pending_turns": set(),
        "session_registry_lock": threading.RLock(),
        "retriever_lock": threading.RLock(),
    }

    def _load_base_config() -> AppConfig:
        if _state["multi_user"] and _state["config_path"]:
            return load_deployment_config(_state["config_path"], cwd=_state["cwd"])
        return load_config(_state["config_path"], cwd=_state["cwd"])

    initial_config = _load_base_config()
    _state["base_config"] = initial_config
    _state["config_version"] = config_hash(initial_config)
    _state["config_reloaded_at"] = time.time()
    _state["retriever_build_semaphore"] = threading.BoundedSemaphore(
        initial_config.retriever.build_concurrency
    )
    _state["agent_init_semaphore"] = asyncio.Semaphore(
        initial_config.server.agent_init_concurrency
    )
    runtime = initial_config.server
    _state["turn_scheduler"] = AgentTurnScheduler(
        max_concurrent=runtime.max_concurrent_requests,
        max_queued=runtime.max_queued_requests,
        max_queued_per_user=runtime.max_queued_requests_per_user,
        queue_timeout_seconds=runtime.request_queue_timeout_seconds,
        priority_aging_seconds=runtime.priority_aging_seconds,
    )

    def _admission_policy(user_id: str | int) -> AdmissionPolicy:
        runtime_config = _state["base_config"].server
        group_name = (
            get_user_admission_group(user_id)
            if _state["multi_user"] and str(user_id) != "default"
            else runtime_config.default_priority_group
        )
        group = runtime_config.priority_groups.get(group_name)
        if group is None:
            group = runtime_config.priority_groups[runtime_config.default_priority_group]
        return AdmissionPolicy(
            priority=group.priority,
            max_concurrent=group.max_concurrent_requests_per_user,
        )

    def _base_config_copy() -> AppConfig:
        return _state["base_config"].model_copy(deep=True)

    def _schedule_title_job(
        session_path: Path,
        *,
        model: str,
        config: AppConfig,
        assistant_response: str | None = None,
    ) -> None:
        if not config.session_titles.enabled or not session_path.exists():
            return
        try:
            header = _read_session_header(session_path)
        except Exception:
            logger.warning("Could not inspect session for title generation", exc_info=True)
            return
        if header.get("title") not in LEGACY_DEFAULT_TITLES:
            return
        key = str(session_path)
        existing = _state["title_tasks"].get(key)
        if existing and not existing.done():
            return
        title_model = config.session_titles.model or model or config.agent.model
        task = asyncio.create_task(_run_title_job(
            session_path, title_model, assistant_response,
            timeout_seconds=config.session_titles.timeout_seconds,
            max_attempts=config.session_titles.max_attempts,
            client_kwargs=config.llm.get_model_client_kwargs(title_model),
        ))
        _state["title_tasks"][key] = task
        task.add_done_callback(lambda _task: _state["title_tasks"].pop(key, None))

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

    def _get_or_create_proxy(user_id: str | int) -> Any | None:
        """Return the shared BM25 proxy for a user, creating it if needed."""
        if not _state["multi_user"]:
            return None
        uid = str(user_id)
        with _state["retriever_lock"]:
            if uid not in _state["retrievers"]:
                from ..retriever import RetrieverProxy

                personal = user_workspace(_state["workspace_root"], user_id)
                shared = shared_workspace(_state["workspace_root"])
                personal.mkdir(parents=True, exist_ok=True)
                shared.mkdir(parents=True, exist_ok=True)
                config = _base_config_copy()
                _state["retrievers"][uid] = RetrieverProxy(
                    workspace_roots=[personal, shared],
                    config=config,
                    build_semaphore=_state["retriever_build_semaphore"],
                    before_rebuild=lambda: _evict_retriever_indexes(
                        exclude_user=uid, reserve=1,
                    ),
                )
            proxy = _state["retrievers"][uid]
            return proxy

    def _evict_retriever_indexes(*, exclude_user: str | None = None, reserve: int = 0) -> dict:
        """Evict idle/LRU BM25 indexes while preserving lightweight proxies."""
        from ..retriever import evict_retriever_proxies

        config = _state["base_config"].retriever
        with _state["retriever_lock"]:
            report = evict_retriever_proxies(
                _state["retrievers"],
                idle_ttl_seconds=config.idle_ttl_seconds,
                max_resident=config.max_resident_users,
                exclude_user=exclude_user,
                reserve=reserve,
            )
        evicted = report["users"]
        if evicted:
            logger.info(
                "Evicted %d BM25 indexes (~%.1f MB): %s",
                len(evicted),
                int(report["released_bytes"]) / (1024 * 1024),
                ", ".join(evicted),
            )
        return report

    def _effective_config(personal: Path, user_id: str | int = "default") -> AppConfig:
        config = _base_config_copy()
        if _state["multi_user"] and str(user_id) != "default":
            preferences = get_user_memory_preferences(user_id)
            if preferences is not None:
                config.memories.use_memories = preferences["use_memories"]
                config.memories.generate_memories = preferences["generate_memories"]
        return config

    def _hydrate_agent_history(
        agent: Any,
        messages: list[dict],
        *,
        user_id: str | int,
        session_id: str,
    ) -> int:
        """Rebuild model history so evicted sessions reload transparently."""
        from langchain_core.messages import AIMessage, ToolMessage
        from ..agent.multimodal import build_human_message

        restored: list = []
        for index, message in enumerate(messages):
            role = message.get("role", "")
            content = message.get("content", "")
            if role == "user":
                paths = list(message.get("attachments") or [])
                try:
                    paths.extend(str(path) for path in resolve_assets(
                        _session_dir(_session_cwd(user_id), user_id),
                        session_id,
                        [image["id"] for image in (message.get("chatImages") or [])],
                    ))
                except (FileNotFoundError, KeyError):
                    pass
                restored.append(build_human_message(content, paths))
                continue
            if role != "assistant":
                continue
            steps = message.get("steps") or []
            # Only real tools become tool_calls — thinking/text blocks are prose.
            tool_steps = [
                step for step in steps
                if step.get("name") not in ("think", "text")
                and step.get("kind") not in ("thinking", "reflection", "text")
            ]
            if not tool_steps:
                restored.append(AIMessage(content=content))
                continue
            tool_calls = [
                {
                    "name": step.get("name", "unknown"),
                    "args": step.get("args") or {},
                    "id": f"restore-{index}-{step_index}",
                }
                for step_index, step in enumerate(tool_steps)
            ]
            restored.append(AIMessage(content=content or "", tool_calls=tool_calls))
            for step_index, step in enumerate(tool_steps):
                output = str(step.get("output", ""))
                if step.get("status") == "interrupted" and not output:
                    output = "[Interrupted by user — tool did not finish]"
                restored.append(ToolMessage(
                    content=output[:500],
                    name=step.get("name", "unknown"),
                    tool_call_id=f"restore-{index}-{step_index}",
                ))
        agent._messages = restored
        return len(restored)

    def _schedule_subagent_auto_continue(session_id: str, user_id: str | int) -> None:
        """If the parent is idle, run a short turn to integrate sub-agent results."""
        key = (str(user_id), session_id)
        s = _state["sessions"].get(key)
        if s is None:
            return
        cfg = getattr(s.agent, "_config", None)
        multi = getattr(cfg, "multi_agent", None) if cfg is not None else None
        has_terminal_notes = bool(getattr(s.agent, "has_pending_task_notifications", lambda: False)())
        # Shell tasks use this same handoff even when multi-agent is disabled;
        # a completed command must not silently vanish from the main chat.
        if (multi is None or not getattr(multi, "auto_continue_on_complete", True)) and not has_terminal_notes:
            return
        s.auto_continue_pending = True
        if s.is_busy:
            # Parent is mid-turn; notifications will be injected on the next stream.
            return
        if s.auto_continue_task is not None and not s.auto_continue_task.done():
            return

        async def _run_auto_continue() -> None:
            # Brief delay so multiple near-simultaneous completions coalesce.
            await asyncio.sleep(0.45)
            current = _state["sessions"].get(key)
            if current is None:
                return
            if current.is_busy:
                # Keep pending flag so the chat finally-hook can re-schedule.
                return
            mgr = getattr(current.agent, "subagent_manager", None)
            notes = list(getattr(mgr, "_notifications", []) or []) if mgr else []
            has_terminal_notes = bool(getattr(current.agent, "has_pending_task_notifications", lambda: False)())
            if not notes and not has_terminal_notes:
                current.auto_continue_pending = False
                return
            current.auto_continue_pending = False
            turn_key = (str(user_id), session_id)
            with _state["session_registry_lock"]:
                if turn_key in _state["pending_turns"] or current.abort_event is not None:
                    current.auto_continue_pending = True
                    return
                _state["pending_turns"].add(turn_key)
                current.abort_event = asyncio.Event()
            turn_lease = None
            try:
                try:
                    turn_lease = await _state["turn_scheduler"].acquire(
                        str(user_id), _admission_policy(user_id)
                    )
                except Exception:
                    current.auto_continue_pending = True
                    return
                current.broadcast_event({
                    "type": "parent_auto_turn_started",
                    "session_id": session_id,
                    "reason": "subagent_completed",
                })
                # Empty user text → notifications alone form the human message.
                # Run through the streaming path so /chat/stop can cancel this
                # otherwise invisible parent turn.
                async def _collect_reply() -> str:
                    final = ""
                    async for event in current.agent.stream(""):
                        if event.get("type") == "response_start":
                            current.broadcast_event({
                                "type": "parent_auto_response_start",
                                "session_id": session_id,
                            })
                        elif (
                            event.get("type") == "response_delta"
                            and event.get("content")
                        ):
                            current.broadcast_event({
                                "type": "parent_auto_response_delta",
                                "session_id": session_id,
                                "content": str(event["content"]),
                            })
                        if event.get("type") == "response" and event.get("content"):
                            final = str(event["content"])
                    return final

                reply_task = asyncio.create_task(_collect_reply())
                abort_task = asyncio.create_task(current.abort_event.wait())
                finished, _ = await asyncio.wait(
                    {reply_task, abort_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if abort_task in finished and current.abort_event.is_set():
                    reply_task.cancel()
                    await asyncio.gather(reply_task, return_exceptions=True)
                    return
                abort_task.cancel()
                await asyncio.gather(abort_task, return_exceptions=True)
                reply = await reply_task
                if reply:
                    session_path = _session_file(_session_cwd(user_id), session_id, user_id)
                    if session_path.exists():
                        _append_session_entry(session_path, {
                            "type": "assistant",
                            "content": reply,
                            "timestamp": _now_iso(),
                            "source": "subagent_auto_continue",
                        })
                    # Push into the open GUI (session file alone is invisible live).
                    current.broadcast_event({
                        "type": "parent_auto_reply",
                        "session_id": session_id,
                        "content": reply,
                        "source": "subagent_auto_continue",
                    })
                    logger.info(
                        "Auto-continued session %s after sub-agent completion",
                        session_id,
                    )
            except Exception:
                logger.exception(
                    "Sub-agent auto-continue failed for session %s", session_id,
                )
            finally:
                if turn_lease is not None:
                    await turn_lease.release()
                with _state["session_registry_lock"]:
                    _state["pending_turns"].discard(turn_key)
                current.abort_event = None
                current.touch()
                current.broadcast_event({
                    "type": "parent_auto_turn_finished",
                    "session_id": session_id,
                })
                # A second worker may have completed while this parent turn
                # was integrating the first.  The normal /chat finally-hook
                # is not involved in an automatic turn, so explicitly start
                # the next coalesced handoff instead of leaving stale prose
                # such as “Timer 2 is still running”.
                current.auto_continue_task = None
                if current.auto_continue_pending:
                    _schedule_subagent_auto_continue(session_id, user_id)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        s.auto_continue_task = loop.create_task(
            _run_auto_continue(),
            name=f"scout-subagent-continue-{session_id}",
        )

    def _create_session_state(session_id: str, user_id: str | int, user: User | None) -> SessionState:
        """Construct one session state. Called in a bounded worker thread."""
        key = (str(user_id), session_id)
        if key not in _state["sessions"]:
            try:
                # Importing the model/graph stack is intentionally deferred
                # until the first chat session. Health, auth, workspace APIs,
                # and static UI startup stay lightweight.
                from ..agent import ScoutAgent
                from ..agent.file_guard import WorkspaceGuard

                async def _req_perms(reason: str, domains: list[str]) -> str:
                    return await _permission_elevation_callback(
                        session_id, user_id, reason, domains,
                    )

                def _on_subagent_complete(record: Any) -> None:
                    # May run on the event loop thread from a sub-agent task.
                    if not bool(getattr(record, "resume_parent_on_complete", False)):
                        return
                    try:
                        _schedule_subagent_auto_continue(session_id, user_id)
                    except Exception:
                        logger.debug("Failed to schedule sub-agent auto-continue", exc_info=True)

                async def _on_subagent_event(event: dict) -> None:
                    key_local = (str(user_id), session_id)
                    state = _state["sessions"].get(key_local)
                    if state is not None:
                        state.touch()
                        state.broadcast_event(event)
                        # Sub-agent transport events are intentionally noisy for
                        # the task detail panel.  The main conversation gets a
                        # small, durable lifecycle record only when work starts
                        # or reaches a terminal state.
                        event_type = str(event.get("type") or "")
                        lifecycle = {
                            "subagent_started": "queued",
                            "subagent_status": "running",
                            "subagent_completed": "completed",
                            "subagent_failed": "failed",
                            "subagent_stopped": "cancelled",
                        }
                        if event_type in lifecycle:
                            mgr = getattr(state.agent, "subagent_manager", None)
                            agent_id = str(event.get("agent_id") or "")
                            detail = mgr.public_detail(agent_id) if mgr and agent_id else None
                            if detail:
                                task = {
                                    "task_id": agent_id,
                                    "task_type": "agent",
                                    "title": detail.get("description") or "Background agent",
                                    "status": lifecycle[event_type],
                                    "created_at": detail.get("created_at"),
                                    "started_at": detail.get("created_at"),
                                    "finished_at": detail.get("finished_at"),
                                    "summary": detail.get("summary"),
                                    "result_preview": detail.get("result_preview"),
                                    "error": detail.get("error"),
                                }
                                if state.task_store is not None:
                                    task, task_sequence = await asyncio.to_thread(state.task_store.upsert, task)
                                else:
                                    task_sequence = 0
                                path = _session_file(_session_cwd(user_id), session_id, user_id)
                                if path.exists():
                                    await asyncio.to_thread(_append_session_entry, path, {
                                        "type": "task",
                                        "timestamp": _now_iso(),
                                        "task": task,
                                    })
                                state.broadcast_event({
                                    "type": "task_event",
                                    "session_id": session_id,
                                    "task": task,
                                    "task_sequence": task_sequence,
                                })
                                if event_type in {"subagent_completed", "subagent_failed", "subagent_stopped"}:
                                    state.broadcast_event({
                                        "type": "subagent_finished_notice",
                                        "session_id": session_id,
                                        "agent_id": agent_id,
                                        "description": task["title"],
                                        "status": task["status"],
                                        "summary": task.get("summary") or task["status"],
                                        "result_preview": task.get("result_preview") or "",
                                    })

                session_model = None
                session_path = _session_file(_session_cwd(user_id), session_id, user_id)
                if session_path.exists():
                    try:
                        session_model = _read_session_header(session_path).get("model")
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
                        request_permissions_fn=_req_perms,
                        on_subagent_complete=_on_subagent_complete,
                    )
                    if agent.subagent_manager is not None:
                        agent.subagent_manager.set_event_listener(_on_subagent_event)
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
                        request_permissions_fn=_req_perms,
                        on_subagent_complete=_on_subagent_complete,
                    )
                    if agent.subagent_manager is not None:
                        agent.subagent_manager.set_event_listener(_on_subagent_event)
                s = SessionState(agent, agent_config.agent.model)
                s.task_store = TaskStore(_session_dir(_session_cwd(user_id), user_id) / f"{session_id}.tasks.sqlite")
                # In-process monitors are intentionally not resurrected after
                # a server restart. Surface the truth instead of a permanent
                # spinner; users can retry a command from the conversation.
                for task in s.task_store.interrupt_orphaned_running():
                    s.broadcast_event({"type": "task_event", "session_id": session_id, "task": task})
                snap = load_session_snapshot(_session_dir(_session_cwd(user_id), user_id), session_id)
                if snap and snap.get("active_profile"):
                    s.active_permission_profile = snap["active_profile"]
                    agent.set_active_profile(snap["active_profile"])
                if snap and snap.get("approval_mode") in APPROVAL_MODES:
                    s.approval_mode = snap["approval_mode"]
                if snap and snap.get("grants"):
                    _state["grant_store"].import_session(
                        str(user_id), session_id, snap["grants"],
                    )
                if snap and snap.get("exec_rules") and agent._execution and agent._execution._orchestrator:
                    agent._execution._orchestrator._session_exec_rules = list(snap["exec_rules"])

                parsed = _parse_session_file(session_path) if session_path.exists() else None
                if parsed and parsed.get("messages"):
                    s.requires_vision = any(
                        image_paths(message.get("attachments")) or message.get("chatImages")
                        for message in parsed["messages"]
                        if message.get("role") == "user"
                    )
                    _hydrate_agent_history(
                        agent,
                        parsed["messages"],
                        user_id=user_id,
                        session_id=session_id,
                    )
                with _state["session_registry_lock"]:
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

    async def _evict_session_states(
        *,
        reserve: int = 0,
        user_id: str | None = None,
        per_user_reserve: int = 0,
    ) -> list[tuple[str, str]]:
        """Close idle/LRU agents while preserving fair per-user capacity."""
        if not _state["multi_user"]:
            return []
        runtime = _state["base_config"].server
        now = time.monotonic()
        with _state["session_registry_lock"]:
            sessions: dict[tuple[str, str], SessionState] = _state["sessions"]
            candidates = [
                (key, state)
                for key, state in sessions.items()
                if (
                    state.abort_event is None
                    and not (
                        getattr(state.agent, "subagent_manager", None)
                        and state.agent.subagent_manager.running_count() > 0
                    )
                )
            ]
            remove_keys = {
                key
                for key, state in candidates
                if now - state.last_activity >= runtime.session_idle_ttl_seconds
            }

            if user_id is not None:
                remaining_user_count = sum(
                    1
                    for key in sessions
                    if key[0] == user_id and key not in remove_keys
                )
                user_allowed = max(
                    0,
                    runtime.max_live_sessions_per_user - per_user_reserve,
                )
                if remaining_user_count > user_allowed:
                    user_lru = sorted(
                        (
                            (key, state)
                            for key, state in candidates
                            if key[0] == user_id
                            and key not in remove_keys
                            and now - state.last_activity
                            >= runtime.session_eviction_grace_seconds
                        ),
                        key=lambda item: item[1].last_activity,
                    )
                    remove_keys.update(
                        key
                        for key, _ in user_lru[: remaining_user_count - user_allowed]
                    )

            remaining_count = len(sessions) - len(remove_keys)
            allowed = max(0, runtime.max_live_sessions - reserve)
            if remaining_count > allowed:
                lru = sorted(
                    (
                        (key, state)
                        for key, state in candidates
                        if key not in remove_keys
                        and now - state.last_activity
                        >= runtime.session_eviction_grace_seconds
                    ),
                    key=lambda item: item[1].last_activity,
                )
                remove_keys.update(key for key, _ in lru[: remaining_count - allowed])
            removed = [
                (key, sessions.pop(key))
                for key in remove_keys
                if key in sessions
            ]

        for key, state in removed:
            try:
                await state.agent.close()
            except Exception:
                logger.warning("Failed to close evicted session %s", key, exc_info=True)
        if removed:
            logger.info("Evicted %d idle session agents", len(removed))
        return [key for key, _ in removed]

    async def _get_session_state(
        session_id: str,
        user_id: str | int = "default",
        user: User | None = None,
    ) -> SessionState:
        """Return a live session, initializing it with bounded concurrency."""
        key = (str(user_id), session_id)
        with _state["session_registry_lock"]:
            existing = _state["sessions"].get(key)
        if existing is not None:
            existing.touch()
            return existing

        locks: dict[tuple[str, str], asyncio.Lock] = _state["session_init_locks"]
        lock = locks.setdefault(key, asyncio.Lock())
        async with lock:
            with _state["session_registry_lock"]:
                existing = _state["sessions"].get(key)
            if existing is not None:
                existing.touch()
                return existing

            uid = str(user_id)
            await _evict_session_states(
                reserve=1,
                user_id=uid,
                per_user_reserve=1,
            )
            runtime = _state["base_config"].server
            with _state["session_registry_lock"]:
                reservations = _state["session_init_reservations"]
                global_at_capacity = (
                    len(_state["sessions"]) + len(reservations)
                    >= runtime.max_live_sessions
                )
                user_at_capacity = (
                    sum(1 for session_key in _state["sessions"] if session_key[0] == uid)
                    + sum(1 for reservation in reservations if reservation[0] == uid)
                    >= runtime.max_live_sessions_per_user
                )
                at_capacity = global_at_capacity or user_at_capacity
                if not at_capacity:
                    reservations.add(key)
            if at_capacity:
                locks.pop(key, None)
                if user_at_capacity:
                    detail = {
                        "code": "USER_SESSION_CAPACITY",
                        "message": "This account has reached its active conversation capacity. Try again shortly.",
                    }
                else:
                    detail = {
                        "code": "SERVER_CAPACITY",
                        "message": "All agent session slots are currently active. Try again shortly.",
                    }
                raise HTTPException(
                    status_code=503,
                    detail=detail,
                    headers={"Retry-After": "10"},
                )
            try:
                try:
                    await asyncio.wait_for(
                        _state["agent_init_semaphore"].acquire(),
                        timeout=runtime.agent_init_timeout_seconds,
                    )
                except TimeoutError as exc:
                    raise HTTPException(
                        status_code=503,
                        detail={
                            "code": "SERVER_BUSY",
                            "message": "Agent initialization is busy. Try again shortly.",
                        },
                        headers={"Retry-After": "5"},
                    ) from exc
                try:
                    state = await asyncio.to_thread(
                        _create_session_state,
                        session_id,
                        user_id,
                        user,
                    )
                finally:
                    _state["agent_init_semaphore"].release()
            finally:
                with _state["session_registry_lock"]:
                    _state["session_init_reservations"].discard(key)
                locks.pop(key, None)
            state.touch()
            return state

    def _persist_runtime_session_state(
        session_id: str,
        user_id: str | int,
        state: SessionState,
    ) -> None:
        """Persist security-relevant session preferences without dropping grants."""
        cwd = _session_cwd(user_id)
        sdir = _session_dir(cwd, user_id)
        existing = load_session_snapshot(sdir, session_id) or {}
        grants = _state["grant_store"].export_session(str(user_id), session_id)
        exec_rules = existing.get("exec_rules", [])
        if state.agent._execution and state.agent._execution._orchestrator:
            exec_rules = list(state.agent._execution._orchestrator._session_exec_rules)
        save_session_snapshot(
            sdir,
            session_id,
            grants=grants or existing.get("grants", []),
            exec_rules=exec_rules,
            active_profile=state.active_permission_profile,
            approval_mode=state.approval_mode,
            parent_session_id=existing.get("parent_session_id"),
        )

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

    async def _wait_for_approval(
        s: SessionState,
        event_data: dict[str, Any],
        *,
        diffs: list[Any] | None = None,
    ) -> ApprovalResponse:
        """Publish and await one serialized approval request for a session."""
        async with s.approval_lock:
            approval_id = str(event_data["approval_id"])
            approval_event = asyncio.Event()
            s.approval_event = approval_event
            s.approval_response = None
            s.pending_approval_id = approval_id
            s.pending_approval_diffs = list(diffs or [])
            s.touch()

            # The chat stream and the durable session-event stream are separate
            # clients. Publish to both when present. If neither is connected,
            # retain one event for the next session-event subscriber.
            delivered = False
            if s.approval_queue is not None:
                await s.approval_queue.put(event_data)
                delivered = True
            if s.event_subscribers:
                s.broadcast_event(event_data)
                delivered = True
            if not delivered:
                await s.idle_approval_queue.put(event_data)

            try:
                await approval_event.wait()
                response = s.approval_response
                if response is None:
                    return ApprovalResponse(
                        approval_id=approval_id,
                        action="no",
                        feedback="Approval was cancelled",
                    )
                return response
            finally:
                retained: list[dict[str, Any]] = []
                while True:
                    try:
                        queued = s.idle_approval_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if queued.get("approval_id") != approval_id:
                        retained.append(queued)
                for queued in retained:
                    s.idle_approval_queue.put_nowait(queued)
                if s.approval_response is None:
                    s.broadcast_event({
                        "type": "approval_cancelled",
                        "approval_id": approval_id,
                    })
                if s.approval_event is approval_event:
                    s.approval_event = None
                    s.approval_response = None
                    s.pending_approval_id = None
                    s.pending_approval_diffs = []

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

        kind = "execution_promotion" if tool_name == "execution_promotion" else "file_changes"
        if not approval_required(s.approval_mode, kind):
            return ("yes", "")

        approval_id = str(uuid.uuid4())
        sub_id = ""
        sub_desc = ""
        if isinstance(args, dict):
            sub_id = str(args.get("_scout_subagent_id") or "")
            sub_desc = str(args.get("_scout_subagent_description") or "")

        # No live UI channel at all → only auto-approve non-subagent local tools
        # (e.g. /init-skill). Background sub-agents must never silent-approve.
        has_ui = (
            s.approval_queue is not None
            or bool(s.event_subscribers)
        )
        if not has_ui and not sub_id:
            return ("yes", "")
        if not has_ui and sub_id:
            # Block until a UI connects or the wait is abandoned via stop.
            logger.info(
                "Sub-agent %s approval waiting for UI (session %s)",
                sub_id, session_id,
            )

        diff_entries = []
        for d in diffs:
            diff_entries.append({
                "path": d.path,
                "status": d.status,
                # Enough for the collapsed UI. Exact content is available from
                # the authenticated approval-diffs endpoint while this request
                # is pending, so truncation is always explicit.
                "diff": d.diff[:12000],
                "truncated": len(d.diff) > 12000,
                "original_chars": len(d.diff),
            })

        event_data = {
            "type": "approval_request",
            "kind": kind,
            "approval_id": approval_id,
            "tool_name": tool_name,
            "diffs": diff_entries,
            "can_share": _state["multi_user"] and is_user_admin(user_id) and kind == "file_changes",
        }
        if sub_id:
            event_data["subagent_id"] = sub_id
            event_data["subagent_description"] = sub_desc

        resp = await _wait_for_approval(s, event_data, diffs=diffs)

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
            s.approval_mode = "allow_edits"
            _persist_runtime_session_state(session_id, user_id, s)
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
        session_id: str,
        user_id: str | int,
        cap: CapabilityRequest,
        subagent_id: str = "",
        subagent_description: str = "",
    ) -> tuple[str, str]:
        """Request user approval for a narrowly scoped capability."""
        key = (str(user_id), session_id)
        s = _state["sessions"].get(key)
        if not s:
            return ("deny", "Session expired")

        if not approval_required(s.approval_mode, "capability"):
            # The orchestrator records the scoped grant from this response.
            return ("allow_session", "")
        if s.approval_queue is None and not s.event_subscribers and not subagent_id:
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
        if subagent_id:
            event_data["subagent_id"] = subagent_id
            event_data["subagent_description"] = subagent_description
        resp = await _wait_for_approval(s, event_data)
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
        if not s:
            return "[REQUEST DENIED] Session expired."
        profile = s.agent._profile
        if not profile.can_request_permissions:
            return "[REQUEST DENIED] Your permission profile cannot request elevation."

        if not approval_required(s.approval_mode, "permission_elevation"):
            if domains:
                _state["grant_store"].add(
                    str(uuid.uuid4()), str(user_id), session_id,
                    "network_domain", {"domains": domains}, grant_scope="session",
            )
            return "Permissions granted automatically by Full access mode."
        if s.approval_queue is None:
            return "[REQUEST DENIED] No active approval channel."

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
        resp = await _wait_for_approval(s, event_data)
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
            # A runtime network grant must never silently change the user's
            # authorization profile or shared-workspace privileges.
            return "Permissions granted for this session."
        return "Permissions granted for this request."

    async def _resource_maintenance() -> None:
        interval = _state["base_config"].server.maintenance_interval_seconds
        try:
            while True:
                await asyncio.sleep(interval)
                await _evict_session_states()
                await asyncio.to_thread(_evict_retriever_indexes)
        except asyncio.CancelledError:
            return

    @app.on_event("startup")
    async def _startup() -> None:
        if _state["multi_user"]:
            shared_workspace(_state["workspace_root"]).mkdir(parents=True, exist_ok=True)
            _state["maintenance_tasks"].append(
                asyncio.create_task(_resource_maintenance())
            )
        logger.info(
            "Scout server started in %s mode (cwd=%s)",
            "multi-user" if multi_user else "local",
            _state["cwd"],
        )
        config = _base_config_copy()
        if config.session_titles.enabled:
            for path in SESSIONS_ROOT.glob("*/*/*.jsonl"):
                try:
                    parsed = _parse_session_file(path)
                    header = _read_session_header(path)
                    if (
                        parsed and header.get("title") in LEGACY_DEFAULT_TITLES
                        and any(m["role"] == "assistant" for m in parsed["messages"])
                    ):
                        _schedule_title_job(
                            path, model=header.get("model") or config.agent.model,
                            config=config,
                        )
                except Exception:
                    logger.warning("Could not resume pending title job for %s", path, exc_info=True)

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        for task in _state["maintenance_tasks"]:
            task.cancel()
        if _state["maintenance_tasks"]:
            await asyncio.gather(*_state["maintenance_tasks"], return_exceptions=True)
        for task in _state["title_tasks"].values():
            task.cancel()
        with _state["session_registry_lock"]:
            sessions = list(_state["sessions"].values())
            _state["sessions"].clear()
        for s in sessions:
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
        user = await asyncio.to_thread(create_user, username, password)
        if not user:
            raise HTTPException(status_code=400, detail="Username already registered")
        return {"status": "ok", "user": {"id": user["id"], "username": user["username"], "is_admin": bool(user.get("is_admin", False))}}

    @app.post("/api/login")
    async def login(req: dict):
        if not _state["multi_user"]:
            raise HTTPException(status_code=400, detail="Multi-user not enabled")
        username = req.get("username")
        password = req.get("password")
        user = await asyncio.to_thread(get_user_by_username, username)
        password_valid = user and await asyncio.to_thread(
            verify_password, password, user["hashed_password"]
        )
        if not password_valid:
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
        s = await _get_session_state(req.session_id, uid, user)
        agent = s.agent
        if s.abort_event is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "SESSION_BUSY",
                    "message": "This conversation already has a response in progress.",
                },
            )

        agent.set_focus_from_attachments(req.attachments or None)

        # Build enriched message with attachment metadata
        message = req.message
        if req.attachments:
            notes = await asyncio.to_thread(build_attachment_notes, req.attachments)
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
        session_requires_vision = s.requires_vision
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
        if images:
            s.requires_vision = True
        if cfg.hooks.enabled:
            await asyncio.to_thread(
                run_hook,
                "UserPromptSubmit",
                {"session_id": req.session_id, "message": message[:500]},
                personal_dir=personal,
                server_mode=_state["multi_user"],
                enabled=True,
            )

        retry_after = _state["base_config"].server.request_queue_timeout_seconds
        admission_started_monotonic = time.monotonic()
        turn_key = (str(uid), req.session_id)
        with _state["session_registry_lock"]:
            if turn_key in _state["pending_turns"] or s.abort_event is not None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "SESSION_BUSY",
                        "message": "This conversation already has a response in progress.",
                    },
                )
            _state["pending_turns"].add(turn_key)
        try:
            turn_lease = await _state["turn_scheduler"].acquire(
                str(uid), _admission_policy(uid)
            )
        except AdmissionRejected as exc:
            with _state["session_registry_lock"]:
                _state["pending_turns"].discard(turn_key)
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "SERVER_CAPACITY",
                    "message": "The server is at maximum capacity right now. Please try again later.",
                },
                headers={"Retry-After": str(retry_after)},
            ) from exc
        except AdmissionTimedOut as exc:
            with _state["session_registry_lock"]:
                _state["pending_turns"].discard(turn_key)
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "SERVER_BUSY",
                    "message": "The server is still at maximum capacity. Please try again in a minute.",
                },
                headers={"Retry-After": str(retry_after)},
            ) from exc
        except BaseException:
            with _state["session_registry_lock"]:
                _state["pending_turns"].discard(turn_key)
            raise

        # A second request for this conversation may have started while this
        # request waited in the admission queue.
        with _state["session_registry_lock"]:
            _state["pending_turns"].discard(turn_key)
            session_became_busy = s.abort_event is not None
            if not session_became_busy:
                s.abort_event = asyncio.Event()
        if session_became_busy:
            await turn_lease.release()
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "SESSION_BUSY",
                    "message": "This conversation already has a response in progress.",
                },
            )

        s.approval_queue = asyncio.Queue()
        s.declined_this_turn = False

        cwd = _session_cwd(uid)
        session_path = _session_file(cwd, req.session_id, uid)
        turn_started_wall = time.time()
        turn_started_monotonic = time.monotonic()
        turn_metric: dict[str, Any] = {
            "started_at": turn_started_wall,
            "queue_wait_ms": round((turn_started_monotonic - admission_started_monotonic) * 1000),
            "time_to_first_visible_ms": None,
            "duration_ms": None,
            "outcome": "completed",
            "events": 0,
        }
        async def _generate_admitted():
            event_count = 0
            first_visible_at: float | None = None

            stream_task: asyncio.Task | None = None
            # Bound the final agent-to-SSE bridge as well as execution output.
            # A slow browser then backpressures the producer instead of growing
            # this queue for the lifetime of a long tool-heavy turn.
            agent_events: asyncio.Queue = asyncio.Queue(maxsize=256)
            first_assistant_response: str | None = None
            terminal_calls: dict[str, dict] = {}

            async def _publish_terminal_task(task: dict) -> None:
                if s.task_store is not None:
                    task, task_sequence = await asyncio.to_thread(s.task_store.upsert, task)
                else:
                    task_sequence = 0
                if session_path.exists():
                    await asyncio.to_thread(_append_session_entry, session_path, {
                        "type": "task", "timestamp": _now_iso(), "task": task,
                    })
                s.broadcast_event({"type": "task_event", "session_id": req.session_id, "task": task, "task_sequence": task_sequence})

            async def _watch_terminal(process_id: int, task_id: str, title: str) -> None:
                """Own a long shell process after the LLM turn has moved on."""
                service = getattr(agent, "execution_service", None)
                try:
                    while service is not None:
                        result = await service.write_stdin(process_id, "", yield_time_ms=30_000)
                        text = result.text
                        if "Process running with session ID" in text:
                            continue
                        failed = text.startswith("[EXEC ERROR]") or "Process exited with code -" in text
                        status = "failed" if failed else "completed"
                        summary = "Command failed" if failed else "Command finished"
                        await _publish_terminal_task({
                            "task_id": task_id, "task_type": "terminal", "title": title,
                            "status": status, "created_at": None,
                            "started_at": None, "finished_at": time.time(),
                            "summary": summary,
                            "result_preview": text[-600:], "error": text[-300:] if failed else None,
                        })
                        agent.queue_task_notification(
                            f"Terminal task '{title}' {status}. {summary}. Output:\n{text[-1200:]}"
                        )
                        _schedule_subagent_auto_continue(req.session_id, uid)
                        return
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    await _publish_terminal_task({"task_id": task_id, "task_type": "terminal", "title": title, "status": "interrupted", "created_at": None, "started_at": None, "finished_at": time.time(), "summary": "Terminal monitor interrupted", "error": str(exc)})
                    agent.queue_task_notification(
                        f"Terminal task '{title}' was interrupted: {exc}"
                    )
                    _schedule_subagent_auto_continue(req.session_id, uid)
                finally:
                    s.terminal_tasks.pop(process_id, None)

            def session_event(payload: dict) -> dict:
                return {**payload, "session_id": req.session_id}

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
                    agent_get = asyncio.ensure_future(agent_events.get())
                    approval_get = asyncio.ensure_future(approval_q.get())
                    abort_get = asyncio.ensure_future(s.abort_event.wait())

                    pending = {agent_get, approval_get, abort_get}
                    finished, still_pending = await asyncio.wait(
                        pending, return_when=asyncio.FIRST_COMPLETED,
                    )

                    for task in still_pending:
                        task.cancel()
                    if still_pending:
                        await asyncio.gather(
                            *still_pending,
                            return_exceptions=True,
                        )

                    for task in finished:
                        result = task.result()

                        if task is agent_get:
                            kind, payload = result
                            if kind == "event":
                                if first_visible_at is None and payload.get("type") in {
                                    "status", "response_delta", "response", "tool_call", "thinking",
                                }:
                                    first_visible_at = time.monotonic()
                                    turn_metric["time_to_first_visible_ms"] = round(
                                        (first_visible_at - turn_started_monotonic) * 1000,
                                    )
                                if payload.get("type") == "tool_call" and payload.get("name") == "exec_command":
                                    terminal_calls[str(payload.get("tool_call_id") or "")] = payload.get("args") or {}
                                if payload.get("type") == "tool_result" and payload.get("name") == "exec_command":
                                    match = re.search(r"Process running with session ID\\s+(\\d+)", str(payload.get("output") or ""))
                                    if match:
                                        process_id = int(match.group(1))
                                        args = terminal_calls.get(str(payload.get("tool_call_id") or ""), {})
                                        title = str(args.get("description") or args.get("cmd") or "Background command")[:100]
                                        task_id = f"terminal-{process_id}"
                                        now = time.time()
                                        await _publish_terminal_task({"task_id": task_id, "task_type": "terminal", "title": title, "status": "running", "created_at": now, "started_at": now, "finished_at": None, "summary": "Running command"})
                                        if process_id not in s.terminal_tasks:
                                            s.terminal_tasks[process_id] = asyncio.create_task(_watch_terminal(process_id, task_id, title))
                                if payload.get("file_changes"):
                                    now = _now_iso()
                                    for change_set in payload.get("file_changes") or []:
                                        if not change_set.get("created_at"):
                                            change_set["created_at"] = now
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
                                turn_metric["outcome"] = "error"
                                exc = payload
                                from ..agent.exceptions import ProviderRateLimitError
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
                            turn_metric["outcome"] = "interrupted"
                            logger.info("Chat interrupted by user (session %s)", req.session_id)
                            # Drain any already-queued agent events (partial tools /
                            # text) so the client can keep them, then signal stop.
                            while True:
                                try:
                                    kind, payload = agent_events.get_nowait()
                                except asyncio.QueueEmpty:
                                    break
                                if kind == "event" and isinstance(payload, dict):
                                    if payload.get("file_changes"):
                                        now = _now_iso()
                                        for change_set in payload.get("file_changes") or []:
                                            if not change_set.get("created_at"):
                                                change_set["created_at"] = now
                                    if payload.get("type") == "response" and payload.get("content"):
                                        first_assistant_response = payload["content"]
                                    event_count += 1
                                    yield ServerSentEvent(
                                        data=json.dumps(session_event(payload)),
                                        event=payload.get("type") or "message",
                                    )
                            yield ServerSentEvent(
                                data=json.dumps(session_event({
                                    "type": "interrupted",
                                    "message": "Interrupted by user",
                                })),
                                event="interrupted",
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
                    _schedule_title_job(
                        session_path, model=s.model, config=cfg,
                        assistant_response=first_assistant_response,
                    )
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                    try:
                        await stream_task
                    except (asyncio.CancelledError, Exception):
                        pass
                logger.info("SSE stream finished (%d events emitted)", event_count)
                turn_metric["events"] = event_count

        async def _generate():
            # The outer boundary is active before the first SSE yield, so a
            # client disconnect at any point cannot leak an admission slot.
            try:
                async for event in _generate_admitted():
                    yield event
            finally:
                turn_metric["duration_ms"] = round((time.monotonic() - turn_started_monotonic) * 1000)
                s.turn_metrics.append(dict(turn_metric))
                if len(s.turn_metrics) > 100:
                    del s.turn_metrics[:-100]
                s.approval_queue = None
                s.abort_event = None
                s.touch()
                await turn_lease.release()
                # If sub-agents finished while this turn was busy, pick them up.
                if s.auto_continue_pending:
                    _schedule_subagent_auto_continue(req.session_id, uid)

        return EventSourceResponse(_generate())

    @app.post("/chat/stop")
    async def stop_chat(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Interrupt an active agent execution.

        Keeps completed work; only cancels the in-flight tool / model call.
        Pending approval dialogs are declined so writes waiting on approval
        never land on disk.
        """
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s and s.abort_event:
            s.abort_event.set()
            # Unblock approval / edit waits so the cancelled tool exits without writing.
            if s.approval_event is not None and not s.approval_event.is_set():
                s.approval_response = ApprovalResponse(
                    approval_id="",
                    action="no",
                    feedback="Interrupted by user",
                )
                s.approval_event.set()
            if s.edit_done_event is not None and not s.edit_done_event.is_set():
                s.edit_done_event.set()
            return {"status": "ok", "message": "Interruption signaled"}
        return {"status": "ok", "message": "No active task to stop"}

    @app.get("/sessions/{session_id}/subagents")
    async def list_session_subagents(
        session_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """List sub-agents for a live session (status snapshot for UI / ops)."""
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s is None:
            return {"session_id": session_id, "subagents": [], "live": False}
        mgr = getattr(s.agent, "subagent_manager", None)
        if mgr is None:
            return {"session_id": session_id, "subagents": [], "live": True, "enabled": False}
        return {
            "session_id": session_id,
            "live": True,
            "enabled": mgr.enabled,
            "running": mgr.running_count(),
            "total": mgr.total_count(),
            "retain_seconds": mgr.terminal_retain_seconds,
            "subagents": mgr.public_snapshot(),
        }

    @app.get("/sessions/{session_id}/subagents/{agent_id}")
    async def get_session_subagent(
        session_id: str,
        agent_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s is None:
            raise HTTPException(status_code=404, detail="Session not live")
        mgr = getattr(s.agent, "subagent_manager", None)
        if mgr is None:
            raise HTTPException(status_code=404, detail="Multi-agent disabled")
        detail = mgr.public_detail(agent_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="Sub-agent not found")
        return {"session_id": session_id, "subagent": detail}

    @app.get("/sessions/{session_id}/tasks")
    async def list_session_tasks(
        session_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Unified task snapshot. Sub-agents are the first task provider.

        The endpoint deliberately has a task-shaped response so terminal task
        providers can join without forcing clients to learn another panel API.
        """
        uid = user.id if user else "default"
        s = await _get_session_state(session_id, uid, user)
        mgr = getattr(s.agent, "subagent_manager", None)
        status_map = {
            "pending": "queued", "running": "running", "completed": "completed",
            "failed": "failed", "stopped": "cancelled",
        }
        tasks = s.task_store.list() if s.task_store is not None else []
        task_ids = {task["task_id"] for task in tasks}
        for agent in (mgr.public_snapshot() if mgr else []):
            if agent["agent_id"] in task_ids:
                continue
            tasks.append({
                "task_id": agent["agent_id"],
                "task_type": "agent",
                "title": agent.get("description") or "Background agent",
                "status": status_map.get(agent.get("status"), "interrupted"),
                "created_at": agent.get("created_at"),
                "started_at": agent.get("created_at"),
                "finished_at": agent.get("finished_at"),
                "summary": agent.get("summary"),
                "result_preview": agent.get("result_preview"),
                "error": agent.get("error"),
            })
        return {"session_id": session_id, "tasks": tasks}

    @app.get("/sessions/{session_id}/diagnostics")
    async def session_diagnostics(
        session_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Opt-in local responsiveness diagnostics for a conversation."""
        uid = user.id if user else "default"
        s = await _get_session_state(session_id, uid, user)
        tasks = s.task_store.list() if s.task_store is not None else []
        return {
            "session_id": session_id,
            "turns": list(s.turn_metrics[-50:]),
            "tasks": tasks,
            "event_replay_depth": len(s.event_history),
        }

    @app.post("/sessions/{session_id}/tasks/{task_id}/stop")
    async def stop_session_task(
        session_id: str,
        task_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Stop a running background terminal task owned by this session."""
        uid = user.id if user else "default"
        s = await _get_session_state(session_id, uid, user)
        task = next((item for item in (s.task_store.list() if s.task_store else []) if item["task_id"] == task_id), None)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        if task.get("task_type") != "terminal":
            raise HTTPException(status_code=400, detail="Only terminal tasks can be stopped here")
        if task.get("status") not in ("queued", "running"):
            return {"status": "ok", "message": "Task already finished"}
        match = re.fullmatch(r"terminal-(\d+)", task_id)
        if match is None:
            raise HTTPException(status_code=400, detail="Invalid terminal task id")
        service = getattr(s.agent, "execution_service", None)
        stopped = bool(service and await service.cancel_process(int(match.group(1))))
        if not stopped:
            raise HTTPException(status_code=409, detail="Terminal process is no longer available")
        watcher = s.terminal_tasks.pop(int(match.group(1)), None)
        if watcher is not None:
            watcher.cancel()
        now = time.time()
        stopped_task = {
            **task, "status": "cancelled", "finished_at": now,
            "summary": "Stopped by user", "error": None,
        }
        if s.task_store is not None:
            stopped_task, sequence = await asyncio.to_thread(s.task_store.upsert, stopped_task)
        else:
            sequence = 0
        s.broadcast_event({"type": "task_event", "session_id": session_id, "task": stopped_task, "task_sequence": sequence})
        return {"status": "ok", "task": stopped_task}

    @app.post("/sessions/{session_id}/subagents/{agent_id}/message")
    async def message_session_subagent(
        session_id: str,
        agent_id: str,
        body: dict,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s is None:
            raise HTTPException(status_code=404, detail="Session not live")
        mgr = getattr(s.agent, "subagent_manager", None)
        if mgr is None:
            raise HTTPException(status_code=404, detail="Multi-agent disabled")
        message = str((body or {}).get("message") or "").strip()
        if not message:
            raise HTTPException(status_code=400, detail="message is required")
        result = await mgr.send_message(agent_id, message, source="user")
        s.touch()
        return {"status": "ok", "result": result}

    @app.post("/sessions/{session_id}/subagents/{agent_id}/stop")
    async def stop_session_subagent(
        session_id: str,
        agent_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s is None:
            raise HTTPException(status_code=404, detail="Session not live")
        mgr = getattr(s.agent, "subagent_manager", None)
        if mgr is None:
            raise HTTPException(status_code=404, detail="Multi-agent disabled")
        result = await mgr.stop(agent_id)
        s.touch()
        return {"status": "ok", "result": result}

    @app.post("/sessions/{session_id}/subagents/{agent_id}/retain")
    async def retain_session_subagent(
        session_id: str,
        agent_id: str,
        body: dict,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Pause eviction while the UI is viewing this agent (Claude retain)."""
        uid = user.id if user else "default"
        key = (str(uid), session_id)
        s = _state["sessions"].get(key)
        if s is None:
            raise HTTPException(status_code=404, detail="Session not live")
        mgr = getattr(s.agent, "subagent_manager", None)
        if mgr is None:
            raise HTTPException(status_code=404, detail="Multi-agent disabled")
        retain = bool((body or {}).get("retain", True))
        ok = mgr.set_retain_open(agent_id, retain)
        if not ok:
            raise HTTPException(status_code=404, detail="Sub-agent not found")
        return {"status": "ok", "retain": retain}

    @app.get("/sessions/{session_id}/subagent-events")
    async def stream_session_subagent_events(
        session_id: str,
        after: int = 0,
        user: User | None = Depends(get_user_context),
    ) -> EventSourceResponse:
        """SSE stream of sub-agent lifecycle + tool events for the Agents panel."""
        uid = user.id if user else "default"
        # Ensure session exists so spawn can happen after connect.
        s = await _get_session_state(session_id, uid, user)
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        s.event_subscribers.append(queue)
        s.touch()

        # Snapshot current agents
        mgr = getattr(s.agent, "subagent_manager", None)
        snapshot = {
            "type": "subagents_snapshot",
            "session_id": session_id,
            "subagents": mgr.public_snapshot() if mgr else [],
        }

        async def _gen():
            try:
                yield ServerSentEvent(
                    data=json.dumps(snapshot),
                    event="subagents_snapshot",
                )
                # Replay events emitted after the client's last confirmed id.
                # The snapshot is authoritative for list state; replay restores
                # completion/approval notifications that happened mid-refresh.
                for event in s.event_history:
                    if int(event.get("event_id") or 0) > after:
                        yield ServerSentEvent(
                            data=json.dumps(event),
                            event=event.get("type") or "message",
                            id=str(event.get("event_id")),
                        )
                # Drain any idle approvals waiting without a chat stream
                while True:
                    try:
                        pending = s.idle_approval_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    yield ServerSentEvent(
                        data=json.dumps(pending),
                        event=pending.get("type") or "approval_request",
                    )
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=25.0)
                    except asyncio.TimeoutError:
                        yield ServerSentEvent(data="{}", event="ping")
                        continue
                    yield ServerSentEvent(
                        data=json.dumps(event),
                        event=event.get("type") or "message",
                    )
            finally:
                if queue in s.event_subscribers:
                    s.event_subscribers.remove(queue)

        return EventSourceResponse(_gen())

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
        s = await _get_session_state(session_id, uid, user)
        agent = s.agent
        restored_count = _hydrate_agent_history(
            agent,
            req.messages,
            user_id=uid,
            session_id=session_id,
        )
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
            if snap.get("approval_mode") in APPROVAL_MODES:
                s.approval_mode = snap["approval_mode"]
        s.touch()
        logger.info("Restored %d messages into agent history", restored_count)
        return {"status": "ok", "count": restored_count}

    @app.get("/health")
    async def health() -> dict:
        """Server health check including execution backend status."""
        uptime = time.time() - _state["start_time"]
        init_error = _state.get("init_error")

        exec_health: dict | None = _state.get("execution_health")
        with _state["session_registry_lock"]:
            live_sessions = list(_state["sessions"].values())
        for s in live_sessions:
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
                with _state["retriever_lock"]:
                    proxies = list(_state["retrievers"].values())
                resident = [proxy for proxy in proxies if proxy.is_resident]
                body["resources"] = {
                    "live_sessions": len(live_sessions),
                    "max_live_sessions": _state["base_config"].server.max_live_sessions,
                    "max_live_sessions_per_user": _state["base_config"].server.max_live_sessions_per_user,
                    "initializing_sessions": len(_state["session_init_reservations"]),
                    "resident_retriever_indexes": len(resident),
                    "max_resident_retriever_indexes": _state["base_config"].retriever.max_resident_users,
                    "estimated_retriever_bytes": sum(
                        proxy.estimated_resident_bytes for proxy in resident
                    ),
                }
                body["resources"].update(await _state["turn_scheduler"].snapshot())
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
        return {
            "execution": health_info,
            "metrics": metrics,
            "admission": await _state["turn_scheduler"].snapshot(),
        }

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
        runtime = candidate.server
        await _state["turn_scheduler"].reconfigure(
            max_concurrent=runtime.max_concurrent_requests,
            max_queued=runtime.max_queued_requests,
            max_queued_per_user=runtime.max_queued_requests_per_user,
            queue_timeout_seconds=runtime.request_queue_timeout_seconds,
            priority_aging_seconds=runtime.priority_aging_seconds,
        )
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
        if not s.pending_approval_id or req.approval_id != s.pending_approval_id:
            raise HTTPException(
                status_code=409,
                detail="This approval request is no longer active",
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

        sessions = await asyncio.to_thread(_list_session_metadata, sdir)
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

    @app.get("/sessions/{session_id}/approval-mode")
    async def get_session_approval_mode(
        session_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Return the persisted interactive-approval policy for a session."""
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        if not _session_file(cwd, session_id, uid).exists():
            raise HTTPException(status_code=404, detail="Session not found")
        state = _state["sessions"].get((str(uid), session_id))
        if state:
            return {"mode": state.approval_mode}
        snap = load_session_snapshot(_session_dir(cwd, uid), session_id) or {}
        mode = snap.get("approval_mode", DEFAULT_APPROVAL_MODE)
        return {"mode": mode if mode in APPROVAL_MODES else DEFAULT_APPROVAL_MODE}

    @app.put("/sessions/{session_id}/approval-mode")
    async def set_session_approval_mode(
        session_id: str,
        req: SessionApprovalModeRequest,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Persist when this session should pause for user approval."""
        if req.mode not in APPROVAL_MODES:
            raise HTTPException(status_code=400, detail="Invalid approval mode")
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        if not _session_file(cwd, session_id, uid).exists():
            raise HTTPException(status_code=404, detail="Session not found")
        state = _state["sessions"].get((str(uid), session_id))
        if state:
            state.approval_mode = req.mode
            _persist_runtime_session_state(session_id, uid, state)
        else:
            sdir = _session_dir(cwd, uid)
            snap = load_session_snapshot(sdir, session_id) or {}
            save_session_snapshot(
                sdir,
                session_id,
                grants=snap.get("grants", []),
                exec_rules=snap.get("exec_rules", []),
                active_profile=snap.get("active_profile"),
                approval_mode=req.mode,
                parent_session_id=snap.get("parent_session_id"),
            )
        return {"mode": req.mode}

    @app.get("/sessions/{session_id}/approvals/{approval_id}/diffs")
    async def get_pending_approval_diffs(
        session_id: str,
        approval_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Return exact proposed diffs while an approval request is pending."""
        uid = user.id if user else "default"
        state = _state["sessions"].get((str(uid), session_id))
        if not state or state.pending_approval_id != approval_id:
            raise HTTPException(status_code=404, detail="Pending approval not found")
        return {
            "diffs": [
                {"path": d.path, "status": d.status, "diff": d.diff}
                for d in state.pending_approval_diffs
            ],
        }

    @app.post("/sessions/{session_id}/file-changes/{change_set_id}/undo")
    async def undo_file_changes(
        session_id: str,
        change_set_id: str,
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Safely undo a stored agent file-change set.

        Undo is conditional: every current file must still match the content
        hash written by the original change. If the user or agent edited a file
        afterward, the request fails instead of clobbering newer work.
        """
        uid = user.id if user else "default"
        cwd = _session_cwd(uid)
        session_path = _session_file(cwd, session_id, uid)
        if not session_path.exists():
            raise HTTPException(status_code=404, detail="Session not found")

        change_set, lines, line_index, set_index = _find_stored_change_set(session_path, change_set_id)
        if change_set.get("undone"):
            return {"status": "already_undone", "change_set_id": change_set_id}

        root = user_workspace(_state["workspace_root"], uid) if _state["multi_user"] and user else Path(_state["cwd"])
        root = root.resolve()
        entries = change_set.get("entries") or []
        if not entries:
            raise HTTPException(status_code=400, detail="Change set is empty")

        targets: list[tuple[Path, dict, bytes | None]] = []
        for entry in entries:
            if not entry.get("reversible"):
                raise HTTPException(status_code=409, detail=f"Change is not reversible: {entry.get('path')}")
            target = _safe_workspace_file(root, str(entry.get("path") or ""))
            current_hash = _hash_file(target)
            expected_hash = entry.get("new_hash")
            if current_hash != expected_hash:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "File changed after this edit; undo was not applied.",
                        "path": entry.get("path"),
                        "expected_hash": expected_hash,
                        "current_hash": current_hash,
                    },
                )
            old_content = _decode_change_content(entry.get("old_content_base64"))
            targets.append((target, entry, old_content))

        undone_paths: list[str] = []
        for target, entry, old_content in targets:
            if old_content is None:
                if target.exists():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(old_content)
            undone_paths.append(str(entry.get("path") or target.name))

        _mark_change_set_undone(lines, line_index, set_index, session_path)
        proxy = _state["retrievers"].get(str(uid))
        if proxy:
            proxy.mark_dirty()
        return {"status": "undone", "change_set_id": change_set_id, "paths": undone_paths}

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
        await asyncio.to_thread(
            _update_session_header,
            path,
            title=title,
            titleGenerationStatus="completed",
            titleGenerationLastError=None,
        )
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
        await asyncio.to_thread(_update_session_header, path, model=req.model)
        key = (str(uid), session_id)
        state = _state["sessions"].get(key)
        if state:
            state.agent.set_model(req.model)
            state.model = req.model
        else:
            state = await _get_session_state(session_id, uid, user)
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
                approval_mode=parent_state.approval_mode,
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
        if req.role == "user" and req.annotations:
            entry["annotations"] = req.annotations
        if req.role == "assistant" and req.steps:
            entry["steps"] = req.steps
        if req.role == "assistant" and req.model:
            entry["model"] = req.model
        if req.role == "assistant" and req.artifacts:
            entry["artifacts"] = req.artifacts
        if req.role == "assistant" and req.file_changes:
            entry["file_changes"] = req.file_changes
        if req.role == "assistant" and req.stopped:
            entry["stopped"] = True

        await asyncio.to_thread(_append_session_entry, path, entry)

        if req.role == "assistant":
            personal = user_workspace(_state["workspace_root"], uid) if _state["multi_user"] else Path(_state["cwd"])
            cfg = _effective_config(personal, uid)
            header = _read_session_header(path)
            _schedule_title_job(
                path, model=req.model or header.get("model") or cfg.agent.model,
                config=cfg, assistant_response=req.content,
            )

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
        with _state["session_registry_lock"]:
            s = _state["sessions"].pop(key, None)
            user_has_live_sessions = any(
                session_user == str(uid)
                for session_user, _ in _state["sessions"]
            )
        if s:
            await s.agent.close()
        if _state["multi_user"] and not user_has_live_sessions:
            proxy = _state["retrievers"].get(str(uid))
            if proxy:
                proxy.evict()
        return {"status": "ok"}

    # ── File listing endpoint (for @ autocomplete) ───────────────────

    @app.get("/files")
    async def list_files(
        prefix: str = Query("", description="Path prefix filter"),
        limit: int = Query(50, ge=1, le=200),
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """List workspace files for @-mention autocomplete.

        Uses the same bounded, filtered search service as the workspace panel,
        keeping autocomplete work off the request event loop.
        """
        locations = _workspace_locations(user)
        files = await asyncio.to_thread(
            search_workspace_files,
            locations,
            prefix,
            limit=limit,
        )
        by_scope = {location.scope: location for location in locations}
        results = []
        for file in files:
            location = by_scope[file["scope"]]
            results.append({
                "path": file["path"],
                "abs_path": str(location.root / file["path"]),
                "scope": file["scope"],
            })
        return {"files": results}

    def _workspace_locations(user: User | None):
        try:
            return workspace_locations(
                workspace_root=_state["workspace_root"],
                cwd=_state["cwd"],
                multi_user=_state["multi_user"],
                user_id=user.id if user else None,
            )
        except WorkspacePathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _workspace_location(user: User | None, scope: str):
        try:
            return location_for_scope(_workspace_locations(user), scope)
        except WorkspacePathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/workspace/roots")
    async def workspace_roots(
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Return visible roots with their first directory level."""
        roots_out: list[dict] = []
        for location in _workspace_locations(user):
            try:
                entries, truncated = await asyncio.to_thread(
                    list_workspace_directory,
                    location,
                )
            except WorkspacePathError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            root = location.descriptor()
            root["children"] = entries
            root["truncated"] = truncated
            roots_out.append(root)
        return {"roots": roots_out}

    @app.get("/workspace/entries")
    async def workspace_entries(
        scope: str = Query(...),
        path: str = Query(""),
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Return one directory level for lazy tree expansion."""
        location = _workspace_location(user, scope)
        try:
            entries, truncated = await asyncio.to_thread(
                list_workspace_directory,
                location,
                path,
            )
        except WorkspacePathError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"scope": scope, "path": path, "entries": entries, "truncated": truncated}

    @app.get("/workspace/search")
    async def workspace_search(
        query: str = Query(..., min_length=1, max_length=200),
        limit: int = Query(80, ge=1, le=200),
        user: User | None = Depends(get_user_context),
    ) -> dict:
        """Search workspace files without blocking request handling."""
        results = await asyncio.to_thread(
            search_workspace_files,
            _workspace_locations(user),
            query,
            limit=limit,
        )
        return {"files": results}

    @app.get("/workspace/content")
    async def workspace_content(
        scope: str = Query(...),
        path: str = Query(...),
        user: User | None = Depends(get_user_context),
    ):
        """Serve a previewable file addressed by scope and relative path."""
        location = _workspace_location(user, scope)
        try:
            target = resolve_workspace_path(location, path, expect="file")
        except WorkspacePathError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if target.suffix.lower() not in RENDERERS or target.stat().st_size > MAX_ARTIFACT_SIZE:
            raise HTTPException(status_code=415, detail="This file type cannot be previewed")
        return FileResponse(target, headers={"Cache-Control": "no-store, max-age=0"})

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
        scope: str | None = Query(None),
        user: User | None = Depends(get_user_context),
    ):
        """Serve a supported workspace artifact from an authorized root."""
        roots: list[Path]
        if _state["multi_user"] and user is not None:
            if scope not in {None, "personal", "shared"}:
                raise HTTPException(status_code=400, detail="Invalid workspace scope")
            personal = user_workspace(_state["workspace_root"], user.id)
            shared = shared_workspace(_state["workspace_root"])
            if scope == "personal":
                roots = [personal]
            elif scope == "shared":
                roots = [shared]
            else:
                roots = [personal, shared]
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
        return {
            "status": "ok",
            "filename": fname,
            "path": fname,
            "abs_path": str(dest.resolve()),
            "scope": "shared" if target == "shared" else "personal",
            "size": len(content),
        }

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
        groups = _state["base_config"].server.priority_groups
        return {
            "users": list_users(),
            "priority_groups": {
                name: group.model_dump() for name, group in groups.items()
            },
        }

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

    @app.patch("/admin/users/{uid}/admission-group")
    async def admin_set_admission_group(
        uid: int, body: dict, user: User = Depends(require_admin)
    ) -> dict:
        group = str(body.get("admission_group", ""))
        if group not in _state["base_config"].server.priority_groups:
            raise HTTPException(status_code=400, detail="Invalid admission_group")
        if not set_user_admission_group(uid, group):
            raise HTTPException(status_code=404, detail="User not found")
        return {"status": "ok", "admission_group": group}

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
        s = await _get_session_state(session_id)
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
