import pytest
from langchain_core.messages import AIMessage, ToolMessage

from scout.agent.graph import (
    _assert_tool_history_complete,
    _route_after_agent,
    _route_after_tools,
    _safe_recent_split,
    _unresolved_tool_call_ids,
)


def test_unresolved_tool_call_detection():
    messages = [
        AIMessage(content="", tool_calls=[{"name": "echo", "args": {}, "id": "call-1"}]),
    ]
    assert _unresolved_tool_call_ids(messages) == ["call-1"]
    with pytest.raises(RuntimeError, match="call-1"):
        _assert_tool_history_complete(messages)

    messages.append(ToolMessage(content="ok", name="echo", tool_call_id="call-1"))
    assert _unresolved_tool_call_ids(messages) == []
    _assert_tool_history_complete(messages)


def test_last_allowed_tool_call_executes_before_wrap_up():
    call = AIMessage(
        content="",
        tool_calls=[{"name": "echo", "args": {"value": "ok"}, "id": "call-1"}],
    )
    state = {"messages": [call], "iteration": 1}
    assert _route_after_agent(state) == "tools"
    with pytest.raises(RuntimeError, match="without resolving"):
        _route_after_tools(state, max_iterations=2)

    state["messages"].append(ToolMessage(content="ok", name="echo", tool_call_id="call-1"))
    assert _route_after_tools(state, max_iterations=2) == "wrap_up"


def test_completed_tool_exchange_continues_before_limit():
    messages = [
        AIMessage(content="", tool_calls=[{"name": "echo", "args": {}, "id": "call-1"}]),
        ToolMessage(content="ok", name="echo", tool_call_id="call-1"),
    ]
    assert _route_after_tools({"messages": messages, "iteration": 1}, max_iterations=3) == "agent"


def test_compression_split_preserves_tool_exchange():
    messages = [
        AIMessage(content="old"),
        AIMessage(content="", tool_calls=[{"name": "echo", "args": {}, "id": "call-1"}]),
        ToolMessage(content="ok", name="echo", tool_call_id="call-1"),
        AIMessage(content="new"),
    ]
    assert _safe_recent_split(messages, split=2) == 1
