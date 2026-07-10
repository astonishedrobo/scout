"""present_files queues existing deliverables as UI artifacts."""

from __future__ import annotations

from pathlib import Path

import pytest

from scout.artifacts import describe_artifact


def test_describe_artifact_for_presentable_markdown(tmp_path: Path):
    target = tmp_path / "notes.md"
    target.write_text("# Hello\n\nWorld.\n", encoding="utf-8")
    art = describe_artifact(target, tmp_path)
    assert art is not None
    assert art["path"] == "notes.md"
    assert art["renderer"] == "markdown"
    assert art["name"] == "notes.md"


def test_describe_artifact_skips_unknown_extension(tmp_path: Path):
    target = tmp_path / "blob.bin"
    target.write_bytes(b"\x00\x01")
    assert describe_artifact(target, tmp_path) is None


@pytest.mark.asyncio
async def test_present_files_tool_node_attaches_artifacts(tmp_path: Path):
    """Exercise the tool-node branch via a minimal bound graph tool list."""
    from langchain_core.messages import AIMessage, HumanMessage
    from scout.agent.graph import build_graph
    from scout.agent.tools import make_tools
    from scout.config import AgentConfig
    from scout.retriever import BM25Retriever
    from scout.config import AppConfig

    (tmp_path / "report.md").write_text("# Report\n\nBody.\n", encoding="utf-8")
    (tmp_path / "chart.png").write_bytes(
        # minimal valid-ish PNG header; size small
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    )

    config = AppConfig()
    tools = make_tools(
        BM25Retriever(config),
        tmp_path,
        disable_write_tools=True,
        allowed_tools=frozenset({
            "present_files", "read_file", "list_files", "think", "ask_user_choice",
        }),
    )
    agent_cfg = AgentConfig(model="openai/gpt-4o-mini", max_iterations=2)
    graph = build_graph(
        agent_cfg,
        tools,
        system_prompt="test",
        cwd=str(tmp_path),
        data_dir=str(tmp_path),
    )

    # Invoke only the tool node by sending an AIMessage with tool_calls.
    # Compiled graph: use astream and only process tools — simpler to call tool_node
    # via graph internals is hard; instead use graph.ainvoke with forced tool call
    # through the public tools list name.
    # Direct approach: get tool_node from the uncompiled graph is not exported.
    # Call present_files tool function + reimplement resolution is weaker.
    # Use graph's nodes if available:
    tool_node = None
    # LangGraph compiled graphs expose nodes via get_graph in some versions.
    state = {
        "messages": [
            HumanMessage(content="show report"),
            AIMessage(
                content="",
                tool_calls=[{
                    "name": "present_files",
                    "args": {"filepaths": ["report.md", "report.md", "chart.png", "missing.txt"]},
                    "id": "tc-present-1",
                    "type": "tool_call",
                }],
            ),
        ],
        "iteration": 0,
    }
    # Find tools node by name on the compiled graph
    result = await graph.nodes["tools"].ainvoke(state)  # type: ignore[index]
    msgs = result["messages"]
    assert len(msgs) == 1
    msg = msgs[0]
    assert msg.name == "present_files"
    assert "Queued 2 file(s)" in msg.content
    arts = msg.additional_kwargs.get("artifacts") or []
    paths = {a["path"] for a in arts}
    assert paths == {"report.md", "chart.png"}
    # Dedupe: report.md only once
    assert len(arts) == 2
