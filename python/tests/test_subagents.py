"""Cold unit tests for rich multi-agent sub-agents (no live LLM calls)."""

from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import AIMessage

from scout.agent.prompts import build_system_prompt
from scout.agent.subagents import (
    MULTI_AGENT_TOOLS,
    SubAgentManager,
    SubAgentNotification,
    format_notifications_block,
    tools_for_agent_type,
)
from scout.config import AppConfig, ExecutionConfig, MemoriesConfig, MultiAgentConfig
from scout.permissions import resolve_profile


def _mgr(**overrides) -> SubAgentManager:
    cfg = MultiAgentConfig(
        enabled=True,
        max_concurrent=2,
        max_total_per_session=4,
        max_iterations=5,
        default_background=True,
        auto_continue_on_complete=False,
        terminal_retain_seconds=60,
    )
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return SubAgentManager(
        config=cfg,
        parent_session_id="sess-1",
        parent_user_id="u1",
    )


class _FakeParent:
    def __init__(self, tmp_path, multi: MultiAgentConfig):
        self._cwd = str(tmp_path)
        self._config = AppConfig(
            multi_agent=multi,
            execution=ExecutionConfig(enabled=False),
            memories=MemoriesConfig(use_memories=False, generate_memories=False),
        )
        self._profile = resolve_profile("contributor")
        self._guard = None
        self._retriever = None
        self._user_id = "u1"
        self._session_id = "sess-1"
        self._server_mode = False
        self._shared_dir = None
        self._grant_store = None
        self._approval_callback = None
        self._approval_callback_args = None
        self._request_permissions_fn = None
        self._subagent_capability_approval = None


def _patch_child_stream(monkeypatch, replies: list[str] | None = None):
    """Replace ScoutAgent.stream with a tiny fake that yields a final response."""
    from scout import agent as agent_mod

    replies = list(replies or ["subagent done"])
    state = {"i": 0}

    class FakeAgent:
        def __init__(self, *args, **kwargs):
            self._messages = []
            self._is_subagent = True
            self._subagents = None

        async def stream(self, user_message, attachments=None):
            text = replies[min(state["i"], len(replies) - 1)]
            state["i"] += 1
            yield {"type": "status", "message": "Thinking"}
            yield {
                "type": "tool_call",
                "name": "list_files",
                "args": {"directory": "."},
                "tool_call_id": "c1",
            }
            yield {
                "type": "tool_result",
                "name": "list_files",
                "output": "file.txt",
                "tool_call_id": "c1",
            }
            yield {"type": "response", "content": text}

        async def close(self):
            return None

        def set_request_permissions_fn(self, fn):
            return None

    monkeypatch.setattr(agent_mod, "ScoutAgent", FakeAgent)
    return state


@pytest.mark.asyncio
async def test_spawn_background_runs_and_notifies(tmp_path, monkeypatch):
    multi = MultiAgentConfig(
        enabled=True, max_concurrent=2, max_total_per_session=4,
        terminal_retain_seconds=60, auto_continue_on_complete=False,
    )
    mgr = _mgr()
    mgr.bind_parent(_FakeParent(tmp_path, multi))
    _patch_child_stream(monkeypatch, ["found auth bug"])

    events: list[dict] = []

    async def on_event(ev):
        events.append(ev)

    mgr.set_event_listener(on_event)

    result = await mgr.spawn(
        description="Auth audit",
        prompt="Find the auth bug",
        agent_type="snoop",
        run_in_background=True,
    )
    assert "async_launched" in result
    assert "agent_id:" in result
    agent_id = next(
        line.split(":", 1)[1].strip()
        for line in result.splitlines()
        if line.startswith("agent_id:")
    )

    for _ in range(50):
        rec = mgr._agents[agent_id]
        if rec.status == "completed":
            break
        await asyncio.sleep(0.05)
    assert mgr._agents[agent_id].status == "completed"
    assert mgr._agents[agent_id].agent_type == "snoop"
    assert "found auth bug" in mgr._agents[agent_id].result
    assert any(e.get("type") == "subagent_started" for e in events)
    assert any(e.get("type") == "subagent_tool_call" for e in events)
    assert any(e.get("type") == "subagent_completed" for e in events)

    notes = mgr.drain_notifications()
    assert len(notes) == 1
    assert notes[0].status == "completed"


@pytest.mark.asyncio
async def test_send_message_followup(tmp_path, monkeypatch):
    multi = MultiAgentConfig(
        enabled=True, terminal_retain_seconds=120, auto_continue_on_complete=False,
    )
    mgr = _mgr(terminal_retain_seconds=120)
    mgr.bind_parent(_FakeParent(tmp_path, multi))
    _patch_child_stream(monkeypatch, ["first report", "follow-up report"])

    out = await mgr.spawn(
        description="Explore",
        prompt="look around",
        agent_type="snoop",
        run_in_background=True,
    )
    agent_id = next(
        line.split(":", 1)[1].strip()
        for line in out.splitlines()
        if line.startswith("agent_id:")
    )
    for _ in range(50):
        if mgr._agents[agent_id].status == "completed":
            break
        await asyncio.sleep(0.05)
    assert mgr._agents[agent_id].status == "completed"

    send = await mgr.send_message(agent_id, "also check configs", source="parent")
    assert "delivered" in send or "Follow-up" in send
    for _ in range(50):
        if "follow-up" in (mgr._agents[agent_id].result or ""):
            break
        await asyncio.sleep(0.05)
    assert "follow-up" in mgr._agents[agent_id].result


@pytest.mark.asyncio
async def test_concurrent_limit(tmp_path, monkeypatch):
    multi = MultiAgentConfig(enabled=True, max_concurrent=1, max_total_per_session=5)
    mgr = _mgr(max_concurrent=1, max_total_per_session=5)
    mgr.bind_parent(_FakeParent(tmp_path, multi))

    from scout import agent as agent_mod

    gate = asyncio.Event()

    class SlowAgent:
        def __init__(self, *a, **k):
            self._messages = []

        async def stream(self, user_message, attachments=None):
            yield {"type": "status", "message": "Thinking"}
            await gate.wait()
            yield {"type": "response", "content": "done"}

        async def close(self):
            return None

    monkeypatch.setattr(agent_mod, "ScoutAgent", SlowAgent)

    r1 = await mgr.spawn(description="One", prompt="task", run_in_background=True)
    assert "async_launched" in r1
    await asyncio.sleep(0.05)
    denied = await mgr.spawn(description="Two", prompt="task", run_in_background=True)
    assert "SPAWN DENIED" in denied
    gate.set()
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_total_limit_does_not_reset_when_finished_agents_archive(tmp_path, monkeypatch):
    multi = MultiAgentConfig(
        enabled=True,
        max_concurrent=1,
        max_total_per_session=2,
        terminal_retain_seconds=15,
        auto_continue_on_complete=False,
    )
    mgr = _mgr(
        max_concurrent=1,
        max_total_per_session=2,
        terminal_retain_seconds=15,
    )
    mgr.bind_parent(_FakeParent(tmp_path, multi))
    _patch_child_stream(monkeypatch, ["first", "second"])

    for description in ("First", "Second"):
        out = await mgr.spawn(
            description=description,
            prompt="finish quickly",
            run_in_background=True,
        )
        agent_id = next(
            line.split(":", 1)[1].strip()
            for line in out.splitlines()
            if line.startswith("agent_id:")
        )
        for _ in range(50):
            if mgr._agents[agent_id].status == "completed":
                break
            await asyncio.sleep(0.02)
        await mgr._expire(mgr._agents[agent_id])

    assert mgr.total_count() == 2
    assert len(mgr.public_snapshot()) == 2
    assert all(a["can_message"] is False for a in mgr.public_snapshot())
    denied = await mgr.spawn(
        description="Third",
        prompt="should not launch",
        run_in_background=True,
    )
    assert "budget exhausted" in denied


@pytest.mark.asyncio
async def test_followup_supersedes_undelivered_completion(tmp_path, monkeypatch):
    multi = MultiAgentConfig(
        enabled=True,
        terminal_retain_seconds=120,
        auto_continue_on_complete=False,
    )
    mgr = _mgr(terminal_retain_seconds=120)
    mgr.bind_parent(_FakeParent(tmp_path, multi))
    _patch_child_stream(monkeypatch, ["old report", "new report"])

    out = await mgr.spawn(
        description="Revise report",
        prompt="draft it",
        run_in_background=True,
    )
    agent_id = next(
        line.split(":", 1)[1].strip()
        for line in out.splitlines()
        if line.startswith("agent_id:")
    )
    for _ in range(50):
        if mgr._agents[agent_id].status == "completed":
            break
        await asyncio.sleep(0.02)
    assert len(mgr._notifications) == 1

    await mgr.send_message(agent_id, "revise it", source="user")
    assert mgr._notifications == []
    for _ in range(50):
        if mgr._agents[agent_id].result == "new report":
            break
        await asyncio.sleep(0.02)
    notes = mgr.drain_notifications()
    assert len(notes) == 1
    assert notes[0].result == "new report"


@pytest.mark.asyncio
async def test_stop_running(tmp_path, monkeypatch):
    multi = MultiAgentConfig(enabled=True)
    mgr = _mgr()
    mgr.bind_parent(_FakeParent(tmp_path, multi))
    from scout import agent as agent_mod

    started = asyncio.Event()

    class HangAgent:
        def __init__(self, *a, **k):
            self._messages = []

        async def stream(self, user_message, attachments=None):
            started.set()
            yield {"type": "status", "message": "Thinking"}
            await asyncio.sleep(30)
            yield {"type": "response", "content": "late"}

        async def close(self):
            return None

    monkeypatch.setattr(agent_mod, "ScoutAgent", HangAgent)
    out = await mgr.spawn(description="Hang", prompt="sleep", run_in_background=True)
    agent_id = next(
        line.split(":", 1)[1].strip()
        for line in out.splitlines()
        if line.startswith("agent_id:")
    )
    await asyncio.wait_for(started.wait(), timeout=2)
    stop = await mgr.stop(agent_id)
    assert "stopped" in stop
    assert mgr._agents[agent_id].status == "stopped"


def test_snoop_tools_read_only():
    tools = tools_for_agent_type("snoop")
    assert "read_file" in tools
    assert "write_file" not in tools
    assert not (tools & MULTI_AGENT_TOOLS)
    # Legacy Claude-ish alias still resolves
    assert tools_for_agent_type("explore") == tools


def test_trailhand_has_shell():
    tools = tools_for_agent_type("trailhand")
    assert "exec_command" in tools
    assert "write_file" in tools
    assert tools_for_agent_type("general-purpose") == tools


def test_profiles_include_send_message():
    for name in ("analyst", "contributor", "admin"):
        p = resolve_profile(name)
        assert "send_subagent_message" in p.allowed_tools
        assert "spawn_subagent" in p.allowed_tools


def test_prompt_multi_agent_section(tmp_path):
    cfg = AppConfig(multi_agent=MultiAgentConfig(enabled=True, max_concurrent=3))
    prompt = build_system_prompt(
        str(tmp_path),
        config=cfg,
        allowed_tools=resolve_profile("contributor").allowed_tools,
    )
    assert "## Multi-Agent Delegation" in prompt
    assert "send_subagent_message" in prompt
    assert "collaborator" in prompt.lower() or "plain language" in prompt.lower()
    assert "Never** paste internal IDs" in prompt or "Never paste internal IDs" in prompt
    assert "Do not invent" in prompt or "timer demo" in prompt.lower()
    assert "Match the user's request" in prompt


def test_notification_format():
    notes = [
        SubAgentNotification(
            agent_id="sa-1",
            description="Explore",
            status="completed",
            summary='Agent "Explore" completed',
            result="ok",
        )
    ]
    block = format_notifications_block(notes)
    assert "subagent-notification" in block
    assert "send_subagent_message" in block


@pytest.mark.asyncio
async def test_parent_injects_notifications(tmp_path, monkeypatch):
    from scout.agent import ScoutAgent

    cfg = AppConfig(
        multi_agent=MultiAgentConfig(enabled=True, auto_continue_on_complete=False),
        execution=ExecutionConfig(enabled=False),
        memories=MemoriesConfig(use_memories=False, generate_memories=False),
    )
    agent = ScoutAgent(
        cwd=str(tmp_path),
        config=cfg,
        session_id="s1",
        user_id="u1",
        server_mode=False,
    )
    assert agent.subagent_manager is not None
    agent.subagent_manager._notifications.append(
        SubAgentNotification(
            agent_id="sa-x",
            description="Seeded",
            status="completed",
            summary='Agent "Seeded" completed',
            result="seed body",
        )
    )

    class FakeGraph:
        async def astream(self, state, config=None):
            human = state["messages"][-1]
            content = human.content if isinstance(human.content, str) else str(human.content)
            assert "subagent-notification" in content
            assert "seed body" in content
            yield {"agent": {"messages": [AIMessage(content="integrated")]}}

    agent._graph = FakeGraph()
    events = [e async for e in agent.stream("continue")]
    assert any(e.get("type") == "response" for e in events)
    await agent.close()
