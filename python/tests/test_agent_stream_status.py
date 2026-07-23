import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from scout.agent import ScoutAgent


@pytest.mark.asyncio
async def test_stream_emits_status_before_graph_runs():
    agent = object.__new__(ScoutAgent)
    agent._messages = []
    agent._execution = None

    stream = agent.stream("hello")
    try:
        assert await anext(stream) == {
            "type": "status",
            "message": "Understanding…",
        }
    finally:
        await stream.aclose()


@pytest.mark.asyncio
async def test_stream_emits_tagged_model_token_deltas():
    class FakeGraph:
        async def astream(self, *_args, stream_mode=None, **_kwargs):
            assert stream_mode == ["messages", "updates"]
            yield (
                "messages",
                (
                    AIMessageChunk(content="Hello", id="run-1"),
                    {"tags": ["scout_visible_response"]},
                ),
            )
            # Untagged internal model output must not reach the browser.
            yield (
                "messages",
                (
                    AIMessageChunk(content="private summary", id="internal"),
                    {"tags": []},
                ),
            )
            yield (
                "messages",
                (
                    AIMessageChunk(content=" world", id="run-1"),
                    {"tags": ["scout_visible_response"]},
                ),
            )
            yield (
                "updates",
                {"agent": {"messages": [AIMessage(content="Hello world")]}},
            )

    agent = object.__new__(ScoutAgent)
    agent._messages = []
    agent._execution = None
    agent._graph = FakeGraph()
    agent._run_config = {}
    agent._cwd = "/workspace"
    agent._shared_dir = None

    events = [event async for event in agent.stream("hello")]
    assert [event for event in events if event["type"] == "response_delta"] == [
        {"type": "response_delta", "content": "Hello"},
        {"type": "response_delta", "content": " world"},
    ]
    assert sum(event["type"] == "response_start" for event in events) == 1
    assert events[-1] == {"type": "response", "content": "Hello world"}


@pytest.mark.asyncio
async def test_stream_sends_full_tool_output_and_bounded_preview():
    content = "a" * 500 + "hidden one\nhidden two"

    class FakeGraph:
        async def astream(self, *_args, **_kwargs):
            yield {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content=content,
                            name="search_workspace",
                            tool_call_id="call-1",
                        )
                    ]
                }
            }

    agent = object.__new__(ScoutAgent)
    agent._messages = []
    agent._execution = None
    agent._graph = FakeGraph()
    agent._run_config = {}

    events = [event async for event in agent.stream("read it")]
    result = next(event for event in events if event["type"] == "tool_result")

    assert result["output"] == content
    assert len(result["output"]) > 500
    assert result["output_preview"].endswith(
        "… +2 more lines (21 characters hidden)"
    )


@pytest.mark.asyncio
async def test_stream_converts_think_tool_to_thinking_event():
    class FakeGraph:
        async def astream(self, *_args, **_kwargs):
            yield {
                "agent": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "think",
                                    "args": {
                                        "title": "Checking the mismatch",
                                        "content": "I found a mismatch, so I will inspect the narrower path next.",
                                    },
                                    "id": "call-1",
                                }
                            ],
                        )
                    ]
                }
            }
            yield {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content="[Thought recorded — continue with your plan.]",
                            name="think",
                            tool_call_id="call-1",
                        )
                    ]
                }
            }

    agent = object.__new__(ScoutAgent)
    agent._messages = []
    agent._execution = None
    agent._graph = FakeGraph()
    agent._run_config = {}
    agent._cwd = "/workspace"
    agent._shared_dir = None

    events = [event async for event in agent.stream("trace it")]

    assert any(
        event == {
            "type": "thinking",
            "title": "Checking the mismatch",
            "content": "I found a mismatch, so I will inspect the narrower path next.",
            "tool_call_id": "call-1",
        }
        for event in events
    )
    assert not any(event.get("type") == "tool_call" and event.get("name") == "think" for event in events)
    assert not any(event.get("type") == "tool_result" and event.get("name") == "think" for event in events)


@pytest.mark.asyncio
async def test_stream_preserves_assistant_text_that_accompanies_tool_call():
    class FakeGraph:
        async def astream(self, *_args, **_kwargs):
            yield {
                "agent": {
                    "messages": [
                        AIMessage(
                            content="I’ll inspect the workspace first, then decide what to check next.",
                            tool_calls=[
                                {
                                    "name": "exec_command",
                                    "args": {"cmd": "ls -la"},
                                    "id": "call-1",
                                }
                            ],
                        )
                    ]
                }
            }
            yield {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content="total 0",
                            name="exec_command",
                            tool_call_id="call-1",
                        )
                    ]
                }
            }

    agent = object.__new__(ScoutAgent)
    agent._messages = []
    agent._execution = None
    agent._graph = FakeGraph()
    agent._run_config = {}
    agent._cwd = "/workspace"
    agent._shared_dir = None

    events = [event async for event in agent.stream("demo")]

    assert events[1] == {
        "type": "assistant_text",
        "content": "I’ll inspect the workspace first, then decide what to check next.",
        "tool_call_id": "call-1",
    }
    assert events[2] == {
        "type": "tool_call",
        "name": "exec_command",
        "args": {"cmd": "ls -la"},
        "tool_call_id": "call-1",
    }


@pytest.mark.asyncio
async def test_stream_emits_structured_user_input_request():
    request = {
        "type": "user_input_request",
        "request_id": "call-1",
        "questions": [
            {
                "id": "question",
                "header": "Choice",
                "question": "Pick one",
                "options": [{"label": "A", "description": "Alpha"}],
                "is_other": True,
            }
        ],
    }

    class FakeGraph:
        async def astream(self, *_args, **_kwargs):
            yield {
                "agent": {
                    "messages": [
                        AIMessage(
                            content="Pick one",
                            additional_kwargs={"user_input_request": request},
                        )
                    ]
                }
            }

    agent = object.__new__(ScoutAgent)
    agent._messages = []
    agent._execution = None
    agent._graph = FakeGraph()
    agent._run_config = {}
    agent._cwd = "/workspace"
    agent._shared_dir = None

    events = [event async for event in agent.stream("choose")]

    assert request in events
    assert not any(event.get("type") == "response" for event in events)
