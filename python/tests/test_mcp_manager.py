from __future__ import annotations

import pytest

from scout.mcp_manager import McpManager
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
