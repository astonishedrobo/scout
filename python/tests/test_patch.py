"""Tests for apply_patch parser and tool-node application."""

from pathlib import Path

import pytest

from scout.agent.patch import parse_patch, parse_unified_patch


def test_parse_single_file_patch(tmp_path: Path):
    f = tmp_path / "hello.txt"
    f.write_text("line1\nline2\n", encoding="utf-8")
    patch = """--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,2 @@
 line1
-line2
+line2 modified
"""
    results = parse_unified_patch(patch, tmp_path)
    assert len(results) == 1
    assert b"line2 modified" in results[0].new_content


def test_parse_codex_freeform_patch(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("line1\nline2\n", encoding="utf-8")
    patch = """*** Begin Patch
*** Update File: hello.txt
@@
 line1
-line2
+line2 modified
*** End Patch
"""
    results = parse_patch(patch, tmp_path)
    assert len(results) == 1
    assert b"line2 modified" in results[0].new_content
    assert results[0].delete is False


def test_parse_codex_delete_patch_is_explicit(tmp_path):
    f = tmp_path / "delete_me.txt"
    f.write_text("remove\n", encoding="utf-8")
    patch = """*** Begin Patch
*** Delete File: delete_me.txt
*** End Patch
"""
    results = parse_patch(patch, tmp_path)
    assert len(results) == 1
    assert results[0].delete is True


def test_parse_empty_file_patch_is_not_delete(tmp_path):
    patch = """*** Begin Patch
*** Add File: empty.txt
*** End Patch
"""
    results = parse_patch(patch, tmp_path)
    assert len(results) == 1
    assert results[0].new_content == b""
    assert results[0].delete is False


@pytest.mark.asyncio
async def test_apply_patch_tool_node_does_not_unbound_describe_artifact(tmp_path: Path):
    """Regression: local import of describe_artifact in present_files must not
    shadow the module import used by apply_patch (UnboundLocalError)."""
    from langchain_core.messages import AIMessage, HumanMessage
    from scout.agent.graph import build_graph
    from scout.agent.tools import make_tools
    from scout.config import AgentConfig, AppConfig
    from scout.retriever import BM25Retriever

    target = tmp_path / "story.md"
    target.write_text("alpha\nbeta\n", encoding="utf-8")

    tools = make_tools(
        BM25Retriever(AppConfig()),
        tmp_path,
        disable_write_tools=False,
        allowed_tools=frozenset({
            "apply_patch", "write_file", "present_files",
            "read_file", "list_files", "think", "ask_user_choice",
        }),
    )
    graph = build_graph(
        AgentConfig(model="openai/gpt-4o-mini", max_iterations=2),
        tools,
        system_prompt="test",
        cwd=str(tmp_path),
        data_dir=str(tmp_path),
        approval_callback=None,  # auto-approve
    )
    patch = """*** Begin Patch
*** Update File: story.md
@@
 alpha
-beta
+beta modified
*** End Patch
"""
    state = {
        "messages": [
            HumanMessage(content="edit story"),
            AIMessage(
                content="",
                tool_calls=[{
                    "name": "apply_patch",
                    "args": {"patch": patch, "description": "tweak beta"},
                    "id": "tc-patch-1",
                    "type": "tool_call",
                }],
            ),
        ],
        "iteration": 0,
    }
    result = await graph.nodes["tools"].ainvoke(state)  # type: ignore[index]
    msg = result["messages"][0]
    assert "UnboundLocalError" not in str(msg.content)
    assert "Applied patch" in msg.content
    assert "beta modified" in target.read_text(encoding="utf-8")
    arts = msg.additional_kwargs.get("artifacts") or []
    assert any(a.get("path") == "story.md" for a in arts)
