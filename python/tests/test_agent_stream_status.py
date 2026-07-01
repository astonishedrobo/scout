import pytest
from langchain_core.messages import ToolMessage

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
            "message": "Thinking through the request",
        }
    finally:
        await stream.aclose()


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
                            name="read_pdf",
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
