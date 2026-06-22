import pytest

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
