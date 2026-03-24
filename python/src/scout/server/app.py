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
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from ..agent import ScoutAgent
from ..agent.exceptions import ProviderRateLimitError
from ..config import GLOBAL_CONFIG_PATH, AppConfig, load_config
from .attachments import build_attachment_notes
from .auth import create_access_token, create_user, get_current_user, get_current_user_optional, get_user_by_username, verify_password, User, ACCESS_TOKEN_EXPIRE_MINUTES
from datetime import timedelta

logger = logging.getLogger(__name__)

# ── Request / response models ────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str
    session_id: str
    attachments: list[str] = []  # list of absolute file paths


class ConfigSetRequest(BaseModel):
    key: str        # dotted path, e.g. "agent.model"
    value: Any
    scope: str = "project"  # "global" or "project"


class ApprovalResponse(BaseModel):
    approval_id: str
    action: str       # "yes", "no", "suggest", "edit", "always"
    feedback: str = ""


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

def _title_from_content(content: str) -> str:
    cleaned = " ".join(content.split()).strip()
    return cleaned[:57] + "…" if len(cleaned) > 60 else cleaned

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
            messages.append({"role": "user", "content": entry.get("content", "")})
            updated_at = entry.get("timestamp", updated_at)
        elif entry.get("type") == "assistant":
            messages.append({
                "role": "assistant",
                "content": entry.get("content", ""),
                "steps": entry.get("steps"),
            })
            updated_at = entry.get("timestamp", updated_at)

    return {
        "meta": {
            "sessionId": header["sessionId"],
            "projectDir": header.get("projectDir", ""),
            "title": header.get("title", "New session"),
            "createdAt": header.get("createdAt", ""),
            "updatedAt": updated_at,
            "messageCount": len(messages),
            "model": header.get("model"),
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

    app = FastAPI(title="Scout Agent Server", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    class SessionState:
        """Isolated state for a single user session."""
        def __init__(self, agent: ScoutAgent):
            self.agent = agent
            self.approval_queue: asyncio.Queue | None = None
            self.approval_event: asyncio.Event | None = None
            self.approval_response: ApprovalResponse | None = None
            self.edit_done_event: asyncio.Event | None = None
            self.declined_this_turn = False
            self.auto_approve = False
            self.abort_event: asyncio.Event | None = None

    # ── State (created on startup) ───────────────────────────────────
    _state: dict[str, Any] = {
        "sessions": {},  # session_id -> SessionState
        "config_path": resolved_config,
        "cwd": resolved_cwd,
        "start_time": time.time(),
        "init_error": None,
        "multi_user": multi_user,
    }

    def _get_session_state(session_id: str, user_id: str | int = "default") -> SessionState:
        """Return the SessionState for a given ID, creating it if needed."""
        key = (str(user_id), session_id)
        if key not in _state["sessions"]:
            try:
                agent = ScoutAgent(
                    config_path=_state["config_path"],
                    cwd=_state["cwd"],
                    approval_callback=_approval_callback,
                    approval_callback_args=(session_id, user_id),
                    read_only=_state["multi_user"],
                )
                _state["sessions"][key] = SessionState(agent)
            except Exception as exc:
                logger.exception("Failed to initialize agent for session %s (user %s)", session_id, user_id)
                raise HTTPException(status_code=500, detail=str(exc))
        
        return _state["sessions"][key]

    # If multi_user is enabled, force safe mode: disable agent write tools
    # This prevents the agent from changing backend server files
    if _state["multi_user"] and hasattr(app, "dependency_overrides"):
        pass  # We'll apply this to config dynamically where needed

    # Helper to enforce auth if multi_user is True
    from fastapi import Depends
    async def get_user_context(user: User | None = Depends(get_current_user_optional)):
        if _state["multi_user"] and not user:
            raise HTTPException(status_code=401, detail="Authentication required")
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

        event_data = {
            "type": "approval_request",
            "approval_id": approval_id,
            "tool_name": tool_name,
            "diffs": diff_entries,
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

        if resp.action == "no":
            s.declined_this_turn = True
        elif resp.action == "always":
            s.auto_approve = True

        return (resp.action, resp.feedback)

    @app.on_event("startup")
    async def _startup() -> None:
        # We no longer initialize a global agent.
        # Agents are created on-demand per session in _get_session_state.
        logger.info(
            "Scout server started in %s mode (cwd=%s)",
            "multi-user" if multi_user else "local",
            _state["cwd"],
        )

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        agent: ScoutAgent | None = _state.get("agent")
        if agent:
            agent.close()

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
        return {"status": "ok", "user": {"id": user["id"], "username": user["username"]}}

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
        return {"access_token": access_token, "token_type": "bearer", "user": {"id": user["id"], "username": user["username"]}}

    @app.post("/chat")
    async def chat(req: ChatRequest, user: User | None = Depends(get_user_context)) -> EventSourceResponse:
        """Stream agent events as SSE."""
        uid = user.id if user else "default"
        s = _get_session_state(req.session_id, uid)
        agent = s.agent

        # Build enriched message with attachment metadata
        message = req.message
        if req.attachments:
            notes = build_attachment_notes(req.attachments)
            if notes:
                message = f"{message}\n\n{notes}"

        logger.info("Chat request received (session %s): %s", req.session_id, message[:120])

        s.approval_queue = asyncio.Queue()
        s.declined_this_turn = False
        s.auto_approve = False
        s.abort_event = asyncio.Event()

        async def _generate():
            event_count = 0

            stream_task: asyncio.Task | None = None
            agent_events: asyncio.Queue = asyncio.Queue()

            async def _drain_agent():
                """Run agent.stream() and push events into agent_events queue."""
                try:
                    async for ev in agent.stream(message):
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

                    for task in finished:
                        result = task.result()

                        if task is agent_get:
                            kind, payload = result
                            if kind == "event":
                                event_count += 1
                                logger.debug(
                                    "SSE event #%d: type=%s",
                                    event_count, payload.get("type"),
                                )
                                yield ServerSentEvent(
                                    data=json.dumps(payload),
                                    event=payload["type"],
                                )
                            elif kind == "error":
                                exc = payload
                                if isinstance(exc, ProviderRateLimitError):
                                    logger.warning("Rate limit during streaming: %s", exc)
                                    yield ServerSentEvent(
                                        data=json.dumps({
                                            "type": "error",
                                            "message": f"Rate limit: {exc}",
                                            "retry_after": getattr(exc, "retry_after", None),
                                        }),
                                        event="error",
                                    )
                                else:
                                    logger.exception("Error during chat streaming: %s", exc)
                                    yield ServerSentEvent(
                                        data=json.dumps({
                                            "type": "error",
                                            "message": f"Server error: {exc}",
                                        }),
                                        event="error",
                                    )
                                done = True
                            elif kind == "done":
                                done = True

                        elif task is abort_get:
                            logger.info("Chat interrupted by user (session %s)", req.session_id)
                            yield ServerSentEvent(
                                data=json.dumps({"type": "error", "message": "Interrupted by user"}),
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
                                data=json.dumps(approval_event),
                                event="approval_request",
                            )

            finally:
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                s.approval_queue = None
                s.abort_event = None
                logger.info("SSE stream finished (%d events emitted)", event_count)

        return EventSourceResponse(_generate())

    @app.post("/chat/stop")
    async def stop_chat(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Interrupt an active agent execution."""
        s = _get_session_state(session_id)
        if s.abort_event:
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
        s = _get_session_state(session_id, uid)
        agent = s.agent

        from langchain_core.messages import AIMessage, HumanMessage

        restored: list = []
        for m in req.messages:
            role = m.get("role", "")
            content = m.get("content", "")
            if role == "user":
                restored.append(HumanMessage(content=content))
            elif role == "assistant":
                restored.append(AIMessage(content=content))
        agent._messages = restored
        logger.info("Restored %d messages into agent history", len(restored))
        return {"status": "ok", "count": len(restored)}

    @app.get("/health")
    async def health() -> dict:
        """Server health check.

        Returns ``{"status": "ok"}`` only when the agent is fully
        initialised.  The CLI polls this endpoint and waits for "ok"
        before marking the server as ready.

        If agent init failed, returns ``{"status": "error", ...}``
        so the CLI can surface the message.
        """
        uptime = time.time() - _state["start_time"]
        agent: ScoutAgent | None = _state.get("agent")
        init_error = _state.get("init_error")

        if agent or _state["multi_user"]:
            return {
                "status": "ok",
                "uptime_seconds": round(uptime, 1),
                "multi_user": _state["multi_user"],
            }
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
        config = load_config(_state["config_path"], cwd=_state["cwd"])
        return config.model_dump()

    @app.get("/config/models")
    async def get_models() -> dict:
        """Return all models aggregated from llm.providers."""
        config = load_config(_state["config_path"], cwd=_state["cwd"])
        return {"models": config.llm.get_all_models()}

    @app.post("/config/reload")
    async def reload_config() -> dict:
        if _state["multi_user"]:
            raise HTTPException(status_code=403, detail="Configuration disabled in server mode")
        """Re-read config from disk and re-inject env vars.

        Called after the user edits config.yaml externally.
        The running agent instance is NOT recreated — only env vars
        are refreshed so subsequent LLM calls pick up new keys.
        """
        config = load_config(_state["config_path"], cwd=_state["cwd"])
        config.llm.inject_env_vars()
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
        cwd = _state["cwd"]
        uid = user.id if user else "default"
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
        cwd = _state["cwd"]
        uid = user.id if user else "default"
        session_id = str(uuid.uuid4())
        sdir = _session_dir(cwd, uid)
        sdir.mkdir(parents=True, exist_ok=True)

        header = {
            "type": "header",
            "sessionId": session_id,
            "projectDir": str(Path(cwd).resolve()),
            "createdAt": _now_iso(),
            "title": "New session",
            "model": model,
        }
        path = _session_file(cwd, session_id, uid)
        path.write_text(json.dumps(header) + "\n", encoding="utf-8")
        return {"sessionId": session_id}

    @app.get("/sessions/{session_id}")
    async def get_session(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Load a full session (meta + messages)."""
        cwd = _state["cwd"]
        uid = user.id if user else "default"
        path = _session_file(cwd, session_id, uid)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Session not found")
        parsed = _parse_session_file(path)
        if not parsed:
            raise HTTPException(status_code=500, detail="Malformed session file")
        return parsed

    @app.post("/sessions/{session_id}/messages")
    async def append_session_message(session_id: str, req: SessionMessageRequest, user: User | None = Depends(get_user_context)) -> dict:
        """Append a message to an existing session."""
        cwd = _state["cwd"]
        uid = user.id if user else "default"
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
        if req.role == "assistant" and req.steps:
            entry["steps"] = req.steps
        if req.role == "assistant" and req.model:
            entry["model"] = req.model

        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

        # Update title from first user message
        if req.role == "user":
            try:
                text = path.read_text(encoding="utf-8")
                lines = text.split("\n")
                header = json.loads(lines[0])
                if header.get("title") == "New session":
                    header["title"] = _title_from_content(req.content)
                    lines[0] = json.dumps(header)
                    path.write_text("\n".join(lines), encoding="utf-8")
            except Exception:
                pass

        return {"status": "ok"}

    @app.delete("/sessions/{session_id}")
    async def delete_session(session_id: str, user: User | None = Depends(get_user_context)) -> dict:
        """Delete a session."""
        cwd = _state["cwd"]
        uid = user.id if user else "default"
        path = _session_file(cwd, session_id, uid)
        if path.exists():
            path.unlink()
        return {"status": "ok"}

    # ── File listing endpoint (for @ autocomplete) ───────────────────

    IGNORED_DIRS = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
        ".next", ".nuxt", ".scout", ".idea", ".vscode",
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
    ) -> dict:
        """List workspace files for @-mention autocomplete.

        Walks the working directory, skipping ignored dirs, binary
        extensions, and sandbox-denied files (whose content is
        bind-mounted to /dev/null but whose directory entries still
        appear in readdir due to how mount namespaces work).
        """
        cwd = Path(_state["cwd"])
        matches: list[tuple[int, str]] = []
        scan_limit = 30_000
        scanned = 0

        for root, dirs, files in _os.walk(cwd):
            dirs[:] = [
                d for d in dirs
                if d not in IGNORED_DIRS and not d.startswith(".")
            ]
            rel_root = Path(root).relative_to(cwd)

            for fname in files:
                ext = Path(fname).suffix.lower()
                if ext in IGNORED_EXTENSIONS:
                    continue
                if _is_sandbox_denied(fname):
                    continue
                rel_path = str(rel_root / fname) if str(rel_root) != "." else fname
                if prefix:
                    score = _fuzzy_file_score(rel_path, prefix)
                    if score is None:
                        continue
                    matches.append((score, rel_path))
                else:
                    matches.append((0, rel_path))
                scanned += 1
                if scanned >= scan_limit:
                    break
            if scanned >= scan_limit:
                break

        if prefix:
            matches.sort(key=lambda x: (-x[0], x[1]))
        else:
            matches.sort(key=lambda x: x[1])
        results = [path for _, path in matches[:limit]]
        return {"files": results[:limit]}

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
