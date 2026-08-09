from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from scout.agent.graph import _completed_duplicate_mcp_call, _tool_result_content


class McpTool:
    mcp_server_id = "demo"


class OrdinaryTool:
    pass


def test_mcp_output_bypasses_blanket_tool_limit():
    output = "complete:" + "x" * 10_000

    assert _tool_result_content(McpTool(), output) == output
    assert len(_tool_result_content(OrdinaryTool(), output)) <= 3_000


def test_completed_duplicate_mcp_call_is_detected_within_user_turn():
    messages = [
        HumanMessage(content="search"),
        AIMessage(content="", tool_calls=[{
            "name": "mcp__demo__search",
            "args": {"query": "F1 standings"},
            "id": "first-call",
        }]),
        ToolMessage(content="complete result", name="mcp__demo__search", tool_call_id="first-call"),
        AIMessage(content="", tool_calls=[{
            "name": "mcp__demo__search",
            "args": {"query": "F1 standings"},
            "id": "second-call",
        }]),
    ]

    assert _completed_duplicate_mcp_call(
        messages, McpTool(), "mcp__demo__search", {"query": "F1 standings"},
    )


def test_failed_mcp_call_can_be_retried():
    messages = [
        HumanMessage(content="search"),
        AIMessage(content="", tool_calls=[{
            "name": "mcp__demo__search",
            "args": {"query": "F1 standings"},
            "id": "first-call",
        }]),
        ToolMessage(content="[MCP tool error] timeout", name="mcp__demo__search", tool_call_id="first-call"),
        AIMessage(content="", tool_calls=[{
            "name": "mcp__demo__search",
            "args": {"query": "F1 standings"},
            "id": "second-call",
        }]),
    ]

    assert not _completed_duplicate_mcp_call(
        messages, McpTool(), "mcp__demo__search", {"query": "F1 standings"},
    )
