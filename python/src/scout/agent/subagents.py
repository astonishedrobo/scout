"""Rich multi-agent sub-agent runtime for Scout.

Design goals (Claude Code / Codex parity, minus per-agent model override):

- Background spawn; parent keeps chatting
- Long-lived child while running; short terminal retain (default 60s, Claude-like)
- Parent re-prompt via ``send_subagent_message``; user steer via inbox API
- Live event log for UI (tool calls, text, status)
- Depth 1 (children cannot spawn); concurrent + total caps
- Completion notifications for the parent agent
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal

if TYPE_CHECKING:
    from ..config import AppConfig, MultiAgentConfig

logger = logging.getLogger(__name__)

# Funky Scout-native roles (not Claude-style general-purpose / Explore / Plan).
AgentTypeName = Literal["trailhand", "snoop", "cartographer"]
SubAgentStatus = Literal[
    "pending", "running", "completed", "failed", "stopped", "expired",
]

VALID_AGENT_TYPES: frozenset[str] = frozenset({"trailhand", "snoop", "cartographer"})
# Accept legacy Claude-ish names so old prompts/sessions don't break.
AGENT_TYPE_ALIASES: dict[str, str] = {
    "general-purpose": "trailhand",
    "general": "trailhand",
    "worker": "trailhand",
    "explore": "snoop",
    "explorer": "snoop",
    "research": "snoop",
    "plan": "cartographer",
    "planner": "cartographer",
}
READONLY_AGENT_TYPES: frozenset[str] = frozenset({"snoop", "cartographer"})
WRITABLE_AGENT_TYPES: frozenset[str] = frozenset({"trailhand"})

SNOOP_TOOLS: frozenset[str] = frozenset({
    "read_file", "list_files", "search_workspace", "filter_table",
    "present_files", "think",
    "memory_search", "memory_read", "memory_list",
    "skill_list", "skill_read",
})
CARTOGRAPHER_TOOLS: frozenset[str] = frozenset(SNOOP_TOOLS)
TRAILHAND_TOOLS: frozenset[str] = frozenset({
    "read_file", "list_files", "search_workspace", "filter_table",
    "present_files",
    "exec_command", "write_stdin", "run_node",
    "write_file", "write_binary_artifact", "apply_patch",
    "memory_search", "memory_read", "memory_list", "memory_add_note",
    "skill_list", "skill_read", "request_permissions",
    "think",
})
MULTI_AGENT_TOOLS: frozenset[str] = frozenset({
    "spawn_subagent", "list_subagents", "get_subagent_result",
    "stop_subagent", "send_subagent_message",
})
AGENT_TYPE_TOOLS: dict[str, frozenset[str]] = {
    "trailhand": TRAILHAND_TOOLS,
    "snoop": SNOOP_TOOLS,
    "cartographer": CARTOGRAPHER_TOOLS,
}
AGENT_TYPE_PROMPTS: dict[str, str] = {
    "trailhand": """\
You are a Scout **trailhand** — the worker who hauls the load and finishes the job. \
Return a short, high-signal report for the parent (who briefs the user).

Voice: concise, direct, lightly human — strong teammate on a voice call. \
No corporate filler, no "I will now…", no tool-name diary.

Work style:
- Smallest tool path that solves the task; batch independent reads.
- Create/edit files only when the deliverable requires it.
- Explicit wait/timer demos: sleep for about the requested duration, then report done. \
  Do not invent unrelated workspace exploration.
- Otherwise finish as soon as the real task is done.

Final report: a few sentences or tight bullets — paths, numbers, outcomes. \
No phase lists, no meta-command menus. You cannot spawn sub-agents.
""",
    "snoop": """\
You are a Scout **snoop** — a curious, fast read-only rummager. Find the answer \
in the workspace and report cleanly so the parent can relay it.

=== READ-ONLY — no create/edit/delete/move; no state-changing commands ===

Search well: start focused (one good query or list); refine only if needed; \
read small windows of known paths; parallelize independent reads; stop when \
you can answer confidently. Synthesize — do not paste long hit dumps.

Voice: fast, precise, a little sly, never smug. Final report names key files \
with brief quotes or one-liners. No tool names or agent IDs. You cannot spawn sub-agents.
""",
    "cartographer": """\
You are a Scout **cartographer** — you map the terrain before anyone digs. \
Produce a concrete implementation plan grounded in real paths and the current \
shape of the workspace.

=== READ-ONLY — do not modify files ===

Keep research tight. Final report: ordered steps, risks, verification notes, \
file paths where known. Clear and direct — no padding, no tool-name chatter. \
You cannot spawn sub-agents.
""",
}

# Back-compat names used in older code/tests
EXPLORE_TOOLS = SNOOP_TOOLS
PLAN_TOOLS = CARTOGRAPHER_TOOLS
GENERAL_PURPOSE_TOOLS = TRAILHAND_TOOLS

AGENT_COLORS = ("rose", "emerald", "violet", "amber", "sky", "fuchsia")
_MAX_EVENTS = 400
_MAX_EVENT_TEXT = 8_000

CompletionCallback = Callable[["SubAgentRecord"], Awaitable[None] | None]
EventListener = Callable[[dict[str, Any]], Awaitable[None] | None]


@dataclass
class SubAgentEvent:
    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "ts": self.ts, **self.payload}


@dataclass
class SubAgentRecord:
    agent_id: str
    description: str
    prompt: str
    agent_type: str
    color: str = "emerald"
    status: SubAgentStatus = "pending"
    result: str = ""
    error: str = ""
    summary: str = ""
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    background: bool = True
    parent_session_id: str = ""
    parent_user_id: str = ""
    tool_use_count: int = 0
    last_activity: str = ""
    notified_completion: bool = False
    retain_open: bool = False  # UI is viewing this agent
    evict_after: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)
    abort_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    inbox: asyncio.Queue = field(default_factory=asyncio.Queue, repr=False)
    events: deque = field(default_factory=lambda: deque(maxlen=_MAX_EVENTS), repr=False)
    child: Any = field(default=None, repr=False)
    _turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def to_public_dict(self, *, include_result: bool = False, include_events: bool = False) -> dict[str, Any]:
        data: dict[str, Any] = {
            "agent_id": self.agent_id,
            "description": self.description,
            "agent_type": self.agent_type,
            "color": self.color,
            "status": self.status,
            "background": self.background,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
            "tool_use_count": self.tool_use_count,
            "last_activity": self.last_activity,
            "summary": self.summary or self._default_summary(),
            "evict_after": self.evict_after,
            "retain_open": self.retain_open,
            "can_message": self.status in {"pending", "running"} or self.child is not None,
        }
        if self.error:
            data["error"] = self.error
        if include_result and self.result:
            data["result"] = self.result
        elif self.result and self.status in {"completed", "failed", "stopped"}:
            preview = self.result.strip()
            if len(preview) > 240:
                preview = preview[:237] + "…"
            data["result_preview"] = preview
        if include_events:
            data["events"] = [e.to_dict() for e in self.events]
        return data

    def _default_summary(self) -> str:
        if self.status == "running":
            return self.last_activity or "Working…"
        if self.status == "completed":
            return "Completed"
        if self.status == "failed":
            return self.error or "Failed"
        if self.status == "stopped":
            return "Stopped"
        if self.status == "expired":
            return "Expired"
        return "Pending"


@dataclass
class SubAgentNotification:
    agent_id: str
    description: str
    status: SubAgentStatus
    summary: str
    result: str = ""
    error: str = ""

    def format_message(self) -> str:
        lines = [
            "<subagent-notification>",
            f"<agent_id>{self.agent_id}</agent_id>",
            f"<status>{self.status}</status>",
            f"<summary>{self.summary}</summary>",
        ]
        if self.result:
            body = self.result.strip()
            if len(body) > 6_000:
                body = body[:5_500] + "\n… [result truncated for parent context]"
            lines.append(f"<result>\n{body}\n</result>")
        if self.error:
            lines.append(f"<error>{self.error}</error>")
        lines.append("</subagent-notification>")
        return "\n".join(lines)


class SubAgentManager:
    """Per-parent-session registry of rich sub-agents."""

    def __init__(
        self,
        *,
        config: "MultiAgentConfig",
        parent_session_id: str,
        parent_user_id: str = "default",
        on_complete: CompletionCallback | None = None,
        on_event: EventListener | None = None,
        persist_path: Path | str | None = None,
    ) -> None:
        self._config = config
        self.parent_session_id = parent_session_id
        self.parent_user_id = parent_user_id
        self._agents: dict[str, SubAgentRecord] = {}
        self._spawn_count = 0
        self._notifications: list[SubAgentNotification] = []
        self._lock = asyncio.Lock()
        self._on_complete = on_complete
        self._on_event = on_event
        self._parent_agent: Any = None
        self._color_i = 0
        self._evict_task: asyncio.Task | None = None
        self._persist_path = Path(persist_path) if persist_path else None

    @property
    def enabled(self) -> bool:
        return bool(self._config.enabled)

    @property
    def terminal_retain_seconds(self) -> int:
        return int(getattr(self._config, "terminal_retain_seconds", 60) or 60)

    def bind_parent(self, parent_agent: Any) -> None:
        self._parent_agent = parent_agent

    def set_completion_callback(self, cb: CompletionCallback | None) -> None:
        self._on_complete = cb

    def set_event_listener(self, cb: EventListener | None) -> None:
        self._on_event = cb

    def running_count(self) -> int:
        return sum(1 for a in self._agents.values() if a.status in {"pending", "running"})

    def total_count(self) -> int:
        return self._spawn_count

    def live_agents(self) -> list[SubAgentRecord]:
        return [a for a in self._agents.values() if a.status != "expired"]

    async def spawn(
        self,
        *,
        description: str,
        prompt: str,
        agent_type: str = "trailhand",
        run_in_background: bool = True,
    ) -> str:
        if not self._config.enabled:
            return "[SPAWN DENIED] Multi-agent spawning is disabled."
        if self._parent_agent is None:
            return "[SPAWN FAILED] Parent agent is not bound."

        description = (description or "").strip()
        prompt = (prompt or "").strip()
        if not description:
            return "[SPAWN FAILED] description is required (3-5 words)."
        if not prompt:
            return "[SPAWN FAILED] prompt is required."
        if len(description) > 80:
            description = description[:77] + "…"

        agent_type = normalize_agent_type(agent_type)
        if agent_type not in VALID_AGENT_TYPES:
            return (
                f"[SPAWN FAILED] Unknown agent_type {agent_type!r}. "
                f"Valid types: {', '.join(sorted(VALID_AGENT_TYPES))} "
                f"(snoop = read-only search, cartographer = plan, trailhand = do the work)."
            )

        async with self._lock:
            await self._evict_expired_unlocked()
            if self.running_count() >= self._config.max_concurrent:
                return (
                    f"[SPAWN DENIED] Concurrent sub-agent limit reached "
                    f"({self._config.max_concurrent}). Wait for one to finish, "
                    f"or stop one with stop_subagent."
                )
            if self._spawn_count >= self._config.max_total_per_session:
                return (
                    f"[SPAWN DENIED] Session sub-agent budget exhausted "
                    f"({self._config.max_total_per_session})."
                )

            agent_id = f"sa-{uuid.uuid4().hex[:10]}"
            color = AGENT_COLORS[self._color_i % len(AGENT_COLORS)]
            self._color_i += 1
            record = SubAgentRecord(
                agent_id=agent_id,
                description=description,
                prompt=prompt,
                agent_type=agent_type,
                color=color,
                status="pending",
                background=run_in_background,
                parent_session_id=self.parent_session_id,
                parent_user_id=self.parent_user_id,
                last_activity="Starting…",
            )
            self._agents[agent_id] = record
            self._spawn_count += 1

        child = self._build_child(record)
        record.child = child
        await record.inbox.put({"role": "system_task", "content": prompt, "source": "spawn"})
        await self._emit(record, "subagent_started", {
            "agent_id": agent_id,
            "description": description,
            "agent_type": agent_type,
            "color": color,
            "status": "pending",
        })

        if run_in_background:
            record.task = asyncio.create_task(
                self._run_loop(record),
                name=f"scout-subagent-{agent_id}",
            )
            self._ensure_evictor()
            return (
                f"status: async_launched\n"
                f"agent_id: {agent_id}\n"
                f"description: {description}\n"
                f"agent_type: {agent_type}\n"
                f"color: {color}\n"
                f"You will be notified automatically when this agent completes. "
                f"Do NOT poll or sleep. Continue other work or respond to the user. "
                f"To re-prompt the same agent while it is alive, use "
                f"send_subagent_message({agent_id!r}, message=...). "
                f"Use stop_subagent({agent_id!r}) only if the direction is wrong."
            )

        # Foreground: run loop until first terminal status, return result.
        record.task = asyncio.create_task(
            self._run_loop(record),
            name=f"scout-subagent-{agent_id}",
        )
        try:
            await record.task
        except Exception as exc:
            return f"[SPAWN FAILED] {exc}"
        return (
            f"status: {record.status}\n"
            f"agent_id: {agent_id}\n"
            f"description: {description}\n"
            f"agent_type: {agent_type}\n"
            f"result:\n{record.result or record.error or '(empty)'}"
        )

    async def send_message(self, agent_id: str, message: str, *, source: str = "parent") -> str:
        agent_id = (agent_id or "").strip()
        message = (message or "").strip()
        if not message:
            return "[SEND FAILED] message is required."
        record = self._agents.get(agent_id)
        if record is None or record.status == "expired":
            return (
                f"[NOT FOUND] No live sub-agent {agent_id!r}. "
                "It may have expired after the retain window; spawn a new one."
            )
        if (
            record.status in {"completed", "failed", "stopped"}
            and record.child is None
        ):
            return (
                f"[SEND FAILED] Sub-agent {agent_id!r} is archived and can no "
                "longer accept follow-ups. Spawn a new agent for more work."
            )
        if record.status == "stopped" and record.evict_after and time.time() > record.evict_after:
            return f"[NOT FOUND] Sub-agent {agent_id!r} was stopped and has expired."

        was_terminal = record.status in {"completed", "failed", "stopped"}
        was_idle = was_terminal or (
            record.task is None or record.task.done()
        )
        if was_terminal:
            # A follow-up supersedes an undelivered completion. Otherwise the
            # parent can auto-integrate the old result while this turn runs.
            if record.task is not None and not record.task.done():
                await asyncio.shield(record.task)
            async with self._lock:
                self._notifications = [
                    note for note in self._notifications
                    if note.agent_id != agent_id
                ]
            record.summary = ""
            record.error = ""
            record.notified_completion = False
        await record.inbox.put({"role": "user", "content": message, "source": source})
        # Show as a normal user turn in the agent timeline (not "queued" jargon).
        await self._emit(record, "subagent_user_message", {
            "agent_id": agent_id,
            "source": source,
            "content": message[:2000],
            "preview": message[:200],
        })
        # Wake a finished agent for a follow-up turn within retain window.
        if record.task is None or record.task.done():
            if record.status in {"completed", "failed", "stopped", "pending"} or was_idle:
                if record.status in {"completed", "failed", "stopped"}:
                    record.abort_event = asyncio.Event()
                    record.evict_after = None
                    record.finished_at = None
                record.status = "running"
                record.last_activity = "Working on follow-up…"
                await self._emit(record, "subagent_status", {
                    "agent_id": agent_id,
                    "status": "running",
                    "last_activity": record.last_activity,
                })
                record.task = asyncio.create_task(
                    self._run_loop(record),
                    name=f"scout-subagent-{agent_id}-followup",
                )
        return (
            f"status: delivered\n"
            f"agent_id: {agent_id}\n"
            f"source: {source}\n"
            f"Follow-up sent. The sub-agent is processing it now."
        )

    def list_agents(self) -> str:
        live = self.live_agents()
        if not live:
            return "No live sub-agents in this session."
        lines = ["Sub-agents:"]
        for agent in live:
            pub = agent.to_public_dict()
            line = (
                f"- {pub['agent_id']} [{pub['status']}] "
                f"{pub['description']} (type={pub['agent_type']}, color={pub['color']})"
            )
            if pub.get("summary"):
                line += f"\n  {pub['summary']}"
            if pub.get("result_preview"):
                line += f"\n  preview: {pub['result_preview']}"
            lines.append(line)
        lines.append(
            f"\nRunning: {self.running_count()} / {self._config.max_concurrent}; "
            f"live: {len(live)} / {self._config.max_total_per_session}; "
            f"retain after done: {self.terminal_retain_seconds}s."
        )
        return "\n".join(lines)

    def get_result(self, agent_id: str) -> str:
        agent_id = (agent_id or "").strip()
        record = self._agents.get(agent_id)
        if record is None or record.status == "expired":
            return f"[NOT FOUND] No sub-agent with id {agent_id!r}."
        if record.status in {"pending", "running"}:
            return (
                f"status: {record.status}\n"
                f"agent_id: {agent_id}\n"
                f"description: {record.description}\n"
                f"activity: {record.last_activity or 'working'}\n"
                "Still running. Prefer automatic notifications over polling."
            )
        parts = [
            f"status: {record.status}",
            f"agent_id: {agent_id}",
            f"description: {record.description}",
            f"agent_type: {record.agent_type}",
        ]
        if record.error:
            parts.append(f"error: {record.error}")
        if record.result:
            parts.append(f"result:\n{record.result}")
        return "\n".join(parts)

    async def stop(self, agent_id: str) -> str:
        agent_id = (agent_id or "").strip()
        record = self._agents.get(agent_id)
        if record is None or record.status == "expired":
            return f"[NOT FOUND] No sub-agent with id {agent_id!r}."
        if record.status not in {"pending", "running"}:
            return (
                f"status: {record.status}\n"
                f"agent_id: {agent_id}\n"
                "Agent is already finished."
            )
        record.abort_event.set()
        # Unblock inbox wait
        try:
            record.inbox.put_nowait({"role": "control", "content": "__stop__", "source": "stop"})
        except asyncio.QueueFull:
            pass
        task = record.task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if record.status in {"pending", "running"}:
            record.status = "stopped"
            record.error = record.error or "Stopped by parent"
            record.finished_at = time.time()
            record.summary = "Stopped"
            self._arm_eviction(record)
            await self._emit(record, "subagent_stopped", {
                "agent_id": agent_id,
                "status": "stopped",
            })
            await self._enqueue_notification(record)
        return f"status: stopped\nagent_id: {agent_id}\ndescription: {record.description}"

    async def stop_all(self) -> None:
        ids = [
            a.agent_id for a in self._agents.values()
            if a.status in {"pending", "running"}
        ]
        for agent_id in ids:
            await self.stop(agent_id)

    def set_retain_open(self, agent_id: str, retain: bool) -> bool:
        record = self._agents.get(agent_id)
        if record is None or record.status == "expired":
            return False
        if record.child is None:
            record.retain_open = False
            record.evict_after = None
            return True
        record.retain_open = retain
        if retain:
            record.evict_after = None
        elif record.status in {"completed", "failed", "stopped"} and record.finished_at:
            self._arm_eviction(record)
        return True

    def public_snapshot(self) -> list[dict[str, Any]]:
        return [a.to_public_dict() for a in self.live_agents()]

    def public_detail(self, agent_id: str) -> dict[str, Any] | None:
        record = self._agents.get(agent_id)
        if record is None or record.status == "expired":
            return None
        return record.to_public_dict(include_result=True, include_events=True)

    def drain_notifications(self) -> list[SubAgentNotification]:
        notes = list(self._notifications)
        self._notifications.clear()
        return notes

    def persist_snapshot(self) -> None:
        """Write durable agent results so refresh/restart does not lose deliverables."""
        if self._persist_path is None:
            return
        try:
            payload = {
                "session_id": self.parent_session_id,
                "updated_at": time.time(),
                "agents": [
                    {
                        "agent_id": a.agent_id,
                        "description": a.description,
                        "agent_type": a.agent_type,
                        "color": a.color,
                        "status": a.status,
                        "result": a.result,
                        "summary": a.summary,
                        "error": a.error,
                        "created_at": a.created_at,
                        "finished_at": a.finished_at,
                        "last_activity": a.last_activity,
                        "tool_use_count": a.tool_use_count,
                        "events": [e.to_dict() for e in list(a.events)[-80:]],
                    }
                    for a in self._agents.values()
                    if a.status != "expired"
                ],
            }
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._persist_path.with_suffix(self._persist_path.suffix + ".tmp")
            tmp.write_text(
                __import__("json").dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.replace(self._persist_path)
        except Exception:
            logger.debug("Failed to persist subagent snapshot", exc_info=True)

    def load_snapshot(self) -> list[dict[str, Any]]:
        """Load last persisted agents (results/events only — not live tasks)."""
        if self._persist_path is None or not self._persist_path.is_file():
            return []
        try:
            data = __import__("json").loads(
                self._persist_path.read_text(encoding="utf-8")
            )
            return list(data.get("agents") or [])
        except Exception:
            logger.debug("Failed to load subagent snapshot", exc_info=True)
            return []

    def hydrate_from_snapshot(self) -> int:
        """Restore finished agents into memory for UI after refresh (not re-run)."""
        rows = self.load_snapshot()
        n = 0
        for row in rows:
            agent_id = str(row.get("agent_id") or "")
            if not agent_id or agent_id in self._agents:
                continue
            status = str(row.get("status") or "completed")
            if status not in {"completed", "failed", "stopped"}:
                status = "completed"
            rec = SubAgentRecord(
                agent_id=agent_id,
                description=str(row.get("description") or agent_id),
                prompt="",
                agent_type=normalize_agent_type(str(row.get("agent_type") or "trailhand")),
                color=str(row.get("color") or "emerald"),
                status=status,  # type: ignore[arg-type]
                result=str(row.get("result") or ""),
                summary=str(row.get("summary") or status),
                error=str(row.get("error") or ""),
                created_at=float(row.get("created_at") or time.time()),
                finished_at=row.get("finished_at"),
                last_activity=str(row.get("last_activity") or ""),
                tool_use_count=int(row.get("tool_use_count") or 0),
                notified_completion=True,
            )
            for ev in row.get("events") or []:
                if isinstance(ev, dict):
                    rec.events.append(SubAgentEvent(
                        type=str(ev.get("type") or "event"),
                        payload={k: v for k, v in ev.items() if k not in {"type", "ts"}},
                        ts=float(ev.get("ts") or time.time()),
                    ))
            # Persisted rows are archived results; their live child context
            # cannot be resumed after a process restart.
            rec.evict_after = None
            self._agents[agent_id] = rec
            self._spawn_count += 1
            n += 1
        return n

    # ── Internals ────────────────────────────────────────────────────

    def _build_child(self, record: SubAgentRecord) -> Any:
        from ..permissions import ProfileConfig
        from . import ScoutAgent

        parent = self._parent_agent
        config: AppConfig = parent._config
        multi = self._config
        agent_type = normalize_agent_type(record.agent_type)
        record.agent_type = agent_type
        allowed = frozenset(
            t for t in tools_for_agent_type(agent_type) if t not in MULTI_AGENT_TOOLS
        )
        parent_profile = getattr(parent, "_profile", None)
        disable_writes = agent_type in READONLY_AGENT_TYPES or (
            parent_profile is not None and parent_profile.disable_write_tools
        )
        allow_shared = bool(parent_profile and parent_profile.allow_shared_write) and not disable_writes
        shell_enabled = agent_type in WRITABLE_AGENT_TYPES and bool(
            parent_profile and parent_profile.shell_enabled
        )
        personal_write = agent_type in WRITABLE_AGENT_TYPES and bool(
            parent_profile and parent_profile.personal_write
        )
        if parent_profile is not None:
            parent_tools = set(parent_profile.allowed_tools) - set(MULTI_AGENT_TOOLS)
            allowed = frozenset(t for t in allowed if t in parent_tools or t == "think")

        # Permission elevation only for writable trailhands
        can_req = (
            agent_type in WRITABLE_AGENT_TYPES
            and not disable_writes
            and bool(parent_profile and parent_profile.can_request_permissions)
        )
        profile = ProfileConfig(
            name=getattr(parent_profile, "name", "contributor"),
            disable_write_tools=disable_writes,
            allow_shared_write=allow_shared,
            shell_enabled=shell_enabled,
            personal_write=personal_write,
            allowed_tools=allowed,
            can_request_permissions=can_req,
        )
        sub_config = config.model_copy(deep=True)
        sub_config.agent.max_iterations = min(
            sub_config.agent.max_iterations, multi.max_iterations,
        )
        sub_config.agent.disable_write_tools = disable_writes
        sub_config.memories.generate_memories = False
        sub_config.session_titles.enabled = False
        sub_config.multi_agent.enabled = False

        shared_raw = getattr(parent, "_shared_dir", None)
        shared_dir = Path(shared_raw) if shared_raw else None

        # Wrap approvals so UI can attribute them to this sub-agent.
        parent_approval = getattr(parent, "_approval_callback", None)
        parent_approval_args = getattr(parent, "_approval_callback_args", None)
        parent_cap = getattr(parent, "_capability_approval_callback", None)
        # capability is stored only as wrapped form on parent sometimes —
        # use execution service's callback path via constructing similar wrappers.
        req_perm = getattr(parent, "_request_permissions_fn", None) if can_req else None

        async def tagged_approval(name, diffs, args):
            if parent_approval is None:
                return ("yes", "")
            # Attach metadata for server UI tagging
            if isinstance(args, dict):
                args = {
                    **args,
                    "_scout_subagent_id": record.agent_id,
                    "_scout_subagent_description": record.description,
                }
            if parent_approval_args:
                return await parent_approval(*parent_approval_args, name, diffs, args)
            return await parent_approval(name, diffs, args)

        async def tagged_capability(cap):
            if parent_cap is None:
                return ("deny", "No capability approval callback")
            if parent_approval_args:
                return await parent_cap(
                    *parent_approval_args,
                    cap,
                    record.agent_id,
                    record.description,
                )
            return await parent_cap(cap)

        child = ScoutAgent(
            cwd=parent._cwd,
            config=sub_config,
            guard=getattr(parent, "_guard", None),
            retriever=getattr(parent, "_retriever", None),
            user_id=str(parent._user_id),
            session_id=str(parent._session_id),
            server_mode=getattr(parent, "_server_mode", False),
            shared_dir=shared_dir,
            grant_store=getattr(parent, "_grant_store", None),
            profile=profile,
            approval_callback=tagged_approval if parent_approval else None,
            approval_callback_args=None,  # already bound in tagged_approval
            capability_approval_callback=tagged_capability if parent_cap else None,
            request_permissions_fn=req_perm,
            is_subagent=True,
        )
        # Tag child for server-side approval routing
        child._subagent_id = record.agent_id
        child._subagent_description = record.description
        return child

    async def _run_loop(self, record: SubAgentRecord) -> None:
        try:
            while not record.abort_event.is_set():
                try:
                    item = await asyncio.wait_for(
                        record.inbox.get(),
                        timeout=0.5 if record.status == "running" else None,
                    )
                except asyncio.TimeoutError:
                    if record.abort_event.is_set():
                        break
                    continue
                except Exception:
                    break

                if not item or item.get("content") == "__stop__":
                    break
                content = str(item.get("content") or "").strip()
                if not content:
                    continue
                source = item.get("source") or "parent"
                if item.get("role") == "system_task":
                    prefix = system_prefix_for_agent_type(record.agent_type)
                    content = (
                        f"{prefix}\n\n## Assigned task\n{content}\n\n"
                        "Complete this efficiently. Your final message is a short report for "
                        "the parent — paths and findings only, no tool-by-tool narration."
                    )
                else:
                    content = (
                        f"[Follow-up from {source}]\n{content}\n\n"
                        "Continue from context. Reply with a concise update only."
                    )

                await self._run_turn(record, content)
                if record.abort_event.is_set():
                    break
                # After a turn, if inbox empty, mark completed and wait for
                # follow-ups until retain expires (handled by outer wait).
                if record.inbox.empty():
                    if record.status not in {"failed", "stopped"}:
                        record.status = "completed"
                        if not record.finished_at:
                            record.finished_at = time.time()
                        if not record.summary:
                            record.summary = "Completed"
                        self._arm_eviction(record)
                        await self._emit(record, "subagent_completed", {
                            "agent_id": record.agent_id,
                            "description": record.description,
                            "status": "completed",
                            "summary": record.summary,
                            "result_preview": (record.result or "")[:240],
                            # Full-ish body so the panel can render without a refetch race.
                            "result": (record.result or "")[:6_000],
                        })
                        self.persist_snapshot()
                        await self._enqueue_notification(record)
                        await self._fire_complete(record)
                    # End the task after each turn. The child conversation stays
                    # alive until its retain deadline; send_message starts a new
                    # task against that same child when a follow-up arrives.
                    break
        except asyncio.CancelledError:
            if record.status in {"pending", "running"}:
                record.status = "stopped"
                record.error = "Cancelled"
                record.finished_at = time.time()
                record.summary = "Stopped"
                self._arm_eviction(record)
                self.persist_snapshot()
            raise
        except Exception as exc:
            logger.exception("Sub-agent %s loop failed", record.agent_id)
            record.status = "failed"
            record.error = str(exc)
            record.finished_at = time.time()
            record.summary = f"Failed: {exc}"
            self._arm_eviction(record)
            await self._emit(record, "subagent_failed", {
                "agent_id": record.agent_id,
                "error": str(exc),
            })
            self.persist_snapshot()
            await self._enqueue_notification(record)
            await self._fire_complete(record)
        finally:
            record.task = None
            self.persist_snapshot()

    async def _run_turn(self, record: SubAgentRecord, message: str) -> None:
        async with record._turn_lock:
            child = record.child
            if child is None:
                child = self._build_child(record)
                record.child = child
            record.status = "running"
            record.last_activity = "Thinking…"
            await self._emit(record, "subagent_status", {
                "agent_id": record.agent_id,
                "status": "running",
                "last_activity": record.last_activity,
            })
            final_text = ""
            try:
                async for ev in child.stream(message):
                    if record.abort_event.is_set():
                        break
                    et = ev.get("type")
                    if et == "tool_call":
                        record.tool_use_count += 1
                        name = ev.get("name") or "tool"
                        args = _bound_args(ev.get("args") or {})
                        record.last_activity = _activity_label(name, args, done=False)
                        await self._emit(record, "subagent_tool_call", {
                            "agent_id": record.agent_id,
                            "name": name,
                            "args": args,
                            "tool_call_id": ev.get("tool_call_id"),
                            "last_activity": record.last_activity,
                        })
                    elif et == "tool_result":
                        name = ev.get("name") or "tool"
                        record.last_activity = _activity_label(name, done=True)
                        out = ev.get("output") or ""
                        # Keep UI timelines light — search dumps are especially noisy.
                        cap = 600 if name in {"search_workspace", "filter_table", "list_files"} else 2_000
                        if len(out) > cap:
                            out = out[:cap] + "…"
                        await self._emit(record, "subagent_tool_result", {
                            "agent_id": record.agent_id,
                            "name": name,
                            "output": out,
                            "tool_call_id": ev.get("tool_call_id"),
                            "last_activity": record.last_activity,
                        })
                    elif et == "thinking":
                        record.last_activity = ev.get("title") or "Thinking…"
                        await self._emit(record, "subagent_thinking", {
                            "agent_id": record.agent_id,
                            "title": ev.get("title") or "",
                            "content": _bound_text(ev.get("content") or ""),
                            "last_activity": record.last_activity,
                        })
                    elif et in {"assistant_text", "response"}:
                        text = ev.get("content") or ""
                        if text:
                            final_text = text
                            record.last_activity = "Writing…"
                            await self._emit(record, "subagent_text", {
                                "agent_id": record.agent_id,
                                "content": _bound_text(text),
                                "final": et == "response",
                                "last_activity": record.last_activity,
                            })
                    elif et == "status":
                        record.last_activity = ev.get("message") or record.last_activity
                    elif et == "error":
                        record.error = ev.get("message") or "error"
                if record.abort_event.is_set():
                    record.status = "stopped"
                    record.error = record.error or "Stopped"
                    record.summary = "Stopped"
                else:
                    record.result = (final_text or record.result or "").strip()
                    if record.result and not record.summary:
                        first = record.result.split("\n", 1)[0].strip()
                        record.summary = first[:160] if first else "Completed"
            except asyncio.CancelledError:
                record.status = "stopped"
                record.error = "Cancelled"
                record.summary = "Stopped"
                raise
            except Exception as exc:
                record.status = "failed"
                record.error = str(exc)
                record.summary = f"Failed: {exc}"
                logger.exception("Sub-agent %s turn failed", record.agent_id)

    async def _emit(self, record: SubAgentRecord, etype: str, payload: dict[str, Any]) -> None:
        event = SubAgentEvent(type=etype, payload=payload)
        record.events.append(event)
        if self._on_event is not None:
            try:
                full = {
                    "type": etype,
                    "ts": event.ts,
                    "session_id": self.parent_session_id,
                    **payload,
                }
                maybe = self._on_event(full)
                if asyncio.iscoroutine(maybe) or asyncio.isfuture(maybe):
                    await maybe  # type: ignore[arg-type]
            except Exception:
                logger.debug("subagent event listener failed", exc_info=True)

    async def _enqueue_notification(self, record: SubAgentRecord) -> None:
        if record.notified_completion:
            return
        record.notified_completion = True
        if record.status == "completed":
            summary = f'Agent "{record.description}" completed'
        elif record.status == "failed":
            summary = f'Agent "{record.description}" failed: {record.error or "unknown"}'
        else:
            summary = f'Agent "{record.description}" was stopped'
        note = SubAgentNotification(
            agent_id=record.agent_id,
            description=record.description,
            status=record.status,
            summary=summary,
            result=record.result if record.status == "completed" else "",
            error=record.error,
        )
        async with self._lock:
            self._notifications.append(note)

    async def _fire_complete(self, record: SubAgentRecord) -> None:
        if self._on_complete is None:
            return
        try:
            maybe = self._on_complete(record)
            if asyncio.iscoroutine(maybe) or asyncio.isfuture(maybe):
                await maybe  # type: ignore[arg-type]
        except Exception:
            logger.debug("completion callback failed", exc_info=True)

    def _arm_eviction(self, record: SubAgentRecord) -> None:
        if record.retain_open:
            record.evict_after = None
            return
        record.evict_after = time.time() + self.terminal_retain_seconds
        self._ensure_evictor()

    def _ensure_evictor(self) -> None:
        if self._evict_task is not None and not self._evict_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._evict_task = loop.create_task(self._evict_loop(), name="scout-subagent-evictor")

    async def _evict_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                async with self._lock:
                    changed = await self._evict_expired_unlocked()
                if not any(
                    a.evict_after or a.status in {"pending", "running"}
                    for a in self._agents.values()
                ):
                    if not changed:
                        # still may have completed with future evict
                        if not any(a.evict_after for a in self._agents.values()):
                            break
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("evict loop error", exc_info=True)

    async def _evict_expired_unlocked(self) -> bool:
        now = time.time()
        changed = False
        for record in list(self._agents.values()):
            if record.status == "expired":
                continue
            if record.retain_open:
                continue
            if record.evict_after is not None and now >= record.evict_after:
                await self._expire(record)
                changed = True
        return changed

    async def _expire(self, record: SubAgentRecord) -> None:
        # Expire only the expensive live child context. Keep the terminal
        # record, result, and timeline visible for the rest of the session.
        record.evict_after = None
        record.retain_open = False
        await self._emit(record, "subagent_context_expired", {
            "agent_id": record.agent_id,
            "status": record.status,
            "can_message": False,
        })
        child = record.child
        record.child = None
        if child is not None:
            try:
                await child.close()
            except Exception:
                logger.debug("error closing expired sub-agent", exc_info=True)
        self.persist_snapshot()


def normalize_agent_type(agent_type: str | None) -> str:
    raw = (agent_type or "trailhand").strip().lower().replace("_", "-")
    raw = raw.replace(" ", "-")
    if raw in VALID_AGENT_TYPES:
        return raw
    if raw in AGENT_TYPE_ALIASES:
        return AGENT_TYPE_ALIASES[raw]
    # Tolerate underscores vs hyphens already handled; try without hyphens
    compact = raw.replace("-", "")
    for valid in VALID_AGENT_TYPES:
        if valid.replace("-", "") == compact:
            return valid
    for alias, target in AGENT_TYPE_ALIASES.items():
        if alias.replace("-", "") == compact:
            return target
    return raw


def tools_for_agent_type(agent_type: str) -> frozenset[str]:
    return AGENT_TYPE_TOOLS.get(normalize_agent_type(agent_type), TRAILHAND_TOOLS)


def system_prefix_for_agent_type(agent_type: str) -> str:
    key = normalize_agent_type(agent_type)
    return AGENT_TYPE_PROMPTS.get(key, AGENT_TYPE_PROMPTS["trailhand"])


def format_notifications_block(
    notes: list[SubAgentNotification],
    *,
    pending_user_request: str = "",
) -> str:
    if not notes:
        return ""
    parts = [
        "[Sub-agent updates — automatically delivered.]",
        "",
        "Instructions for you (parent):",
        "- Integrate useful results into a natural reply for the user.",
        "- Do not re-spawn the same work.",
        "- If the user's pending request asked YOU to save/write a file from the "
        "sub-agent's output (e.g. write the essay to test-cat-sub.md), do that now "
        "with write_file / apply_patch using the result below.",
        "- When multiple results exist for the same task, prefer the **most recent** "
        "completed result (bottom of this list). Do not ask the user which version "
        "unless the results are about clearly different topics.",
        "- Do **not** use ask_user_choice for file-save disambiguation of sequential "
        "revisions of the same deliverable.",
        "- If the result needs refinement while the worker is still available, use "
        "send_subagent_message instead of spawning a duplicate worker.",
        "- Do not claim you saved a file unless a write tool succeeded.",
        "",
    ]
    if pending_user_request.strip():
        parts.extend([
            "## Pending user request (complete this if still unfinished)",
            pending_user_request.strip()[:4_000],
            "",
        ])
    for note in notes:
        parts.append(note.format_message())
        parts.append("")
    return "\n".join(parts).rstrip()


def _bound_text(text: str, limit: int = _MAX_EVENT_TEXT) -> str:
    text = text if isinstance(text, str) else str(text or "")
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _bound_args(args: dict) -> dict:
    out: dict[str, Any] = {}
    for k, v in list(args.items())[:20]:
        if k.startswith("_scout_"):
            continue
        s = v if isinstance(v, (int, float, bool)) or v is None else str(v)
        if isinstance(s, str) and len(s) > 500:
            s = s[:500] + "…"
        out[k] = s
    return out


def _activity_label(name: str, args: dict | None = None, *, done: bool = False) -> str:
    """Human activity strings for UI (avoid raw tool-name noise)."""
    args = args or {}
    path = str(args.get("path") or args.get("directory") or "").strip()
    query = str(args.get("query") or "").strip()
    present = {
        "search_workspace": "Searching workspace" if not done else "Searched workspace",
        "list_files": "Checking files" if not done else "Checked files",
        "read_file": (
            (f"Reading {path}" if path else "Reading a file")
            if not done
            else (f"Read {path}" if path else "Read a file")
        ),
        "filter_table": "Filtering table" if not done else "Filtered table",
        "exec_command": "Running command" if not done else "Ran command",
        "run_node": "Running JavaScript" if not done else "Ran JavaScript",
        "write_file": (
            (f"Writing {path}" if path else "Writing a file")
            if not done
            else (f"Wrote {path}" if path else "Wrote a file")
        ),
        "apply_patch": "Updating files" if not done else "Updated files",
        "think": "Thinking…" if not done else "Thought",
    }
    label = present.get(name, ("Working…" if not done else "Done"))
    if name == "search_workspace" and query:
        label = f"{label}: {query[:48]}"
    return label
