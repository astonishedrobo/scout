from __future__ import annotations

import pytest

from scout.mcp_manager import MAX_MCP_RESULT, McpManager, _result_text
from scout.mcp_store import McpStore


def test_mcp_adapter_attaches_runtime_metadata(tmp_path):
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({
        "id": "demo",
        "name": "Demo",
        "transport": "streamable_http",
        "url": "https://example.test/mcp",
    })
    manager = McpManager(store)
    tool = manager._adapter(
        store.get_server("demo"),
        {
            "name": "echo",
            "description": "Echo text",
            "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}},
            "read_only": True,
        },
        "1",
    )

    assert tool.name == "mcp__demo__echo"
    assert tool.mcp_server_id == "demo"
    assert tool.mcp_tool_name == "echo"
    assert tool.mcp_read_only is True


def test_mcp_result_prefers_complete_structured_content():
    class Result:
        content = [{"type": "text", "text": "duplicated fallback"}]
        structuredContent = {"rows": [{"position": n} for n in range(1, 21)]}
        isError = False

    output = _result_text(Result())

    assert '"position": 20' in output
    assert "duplicated fallback" not in output


def test_mcp_emergency_bound_is_explicit_and_keeps_tail():
    class Result:
        content = [{"type": "text", "text": "start" + "x" * MAX_MCP_RESULT + "THE-END"}]
        structuredContent = None
        isError = False

    output = _result_text(Result())

    assert len(output) == MAX_MCP_RESULT
    assert "emergency context bound" in output
    assert output.endswith("THE-END")


@pytest.mark.asyncio
async def test_container_invoke_returns_worker_text(tmp_path, monkeypatch):
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({
        "id": "demo",
        "name": "Demo",
        "transport": "container_stdio",
        "image": "example/demo@sha256:123",
    })
    manager = McpManager(store)

    async def worker_request(method, path, payload):
        assert method == "POST"
        assert path == "/mcp/call"
        assert payload["arguments"] == {"message": "hello"}
        return {"content": [{"type": "text", "text": "hello"}], "isError": False}

    monkeypatch.setattr(manager, "_worker_request", worker_request)

    assert await manager._invoke("demo", "1", "echo", {"message": "hello"}) == "hello"


@pytest.mark.asyncio
async def test_shared_credential_prevents_personal_override(tmp_path, monkeypatch):
    monkeypatch.setenv("SCOUT_SECRET_KEY", "test-secret")
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({
        "id": "exa",
        "name": "Exa Search",
        "transport": "streamable_http",
        "url": "https://mcp.exa.ai/mcp",
        "availability": "everyone",
        "auth_mode": "bearer",
    })
    store.set_user("exa", 7, enabled=True, credential="old-user-token")
    store.set_shared_credential("exa", "deployment-token")
    manager = McpManager(store)
    received = []

    async def connect(server_id, *, credential=None, user_id=None):
        received.append((server_id, credential, user_id))
        return {"status": "connected", "tool_count": 0}

    monkeypatch.setattr(manager, "connect", connect)

    assert await manager.ensure_user_tools(7) == []
    assert received == [("exa", None, "7")]
