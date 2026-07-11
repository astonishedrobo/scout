import asyncio

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool

from scout.agent.graph import build_graph
from scout.config import AgentConfig


@pytest.mark.asyncio
async def test_independent_read_tools_run_concurrently_and_keep_call_order(tmp_path):
    started = 0
    both_started = asyncio.Event()

    async def rendezvous(label: str) -> str:
        nonlocal started
        started += 1
        if started == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=0.5)
        return label

    @tool("read_file")
    async def read_file(path: str) -> str:
        """Read a test file."""
        return await rendezvous(f"read:{path}")

    @tool("list_files")
    async def list_files(directory: str = ".") -> str:
        """List test files."""
        return await rendezvous(f"list:{directory}")

    graph = build_graph(
        AgentConfig(model="openai/gpt-4o-mini", max_iterations=2),
        [read_file, list_files],
        system_prompt="test",
        cwd=str(tmp_path),
        data_dir=str(tmp_path),
        hooks_enabled=False,
    )
    state = {
        "messages": [
            HumanMessage(content="inspect both"),
            AIMessage(content="", tool_calls=[
                {"name": "read_file", "args": {"path": "a.txt"}, "id": "read-1", "type": "tool_call"},
                {"name": "list_files", "args": {"directory": "data"}, "id": "list-1", "type": "tool_call"},
            ]),
        ],
        "iteration": 0,
    }

    result = await graph.nodes["tools"].ainvoke(state)  # type: ignore[index]

    assert [message.tool_call_id for message in result["messages"]] == ["read-1", "list-1"]
    assert [message.content for message in result["messages"]] == ["read:a.txt", "list:data"]
