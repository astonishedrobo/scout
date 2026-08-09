from __future__ import annotations

from scout.mcp_store import McpStore


def test_mcp_registry_is_persistent_and_user_scoped(tmp_path, monkeypatch):
    monkeypatch.setenv("SCOUT_SECRET_KEY", "test-secret")
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({
        "id": "asana", "name": "Asana", "transport": "streamable_http",
        "url": "https://mcp.example.test/mcp", "availability": "selected",
    })
    store.set_user("asana", 7, enabled=True, credential="user-token")
    assert store.allowed_for_user("asana", 7)
    assert not store.allowed_for_user("asana", 8)
    assert store.user_config("asana", 7)["credential"] == "user-token"

    reopened = McpStore(tmp_path / "mcp.sqlite")
    assert reopened.user_config("asana", 7)["credential"] == "user-token"
    assert reopened.user_config("asana", 7)["enabled"] is True


def test_shared_credential_satisfies_user_setup_and_takes_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv("SCOUT_SECRET_KEY", "test-secret")
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({
        "id": "exa", "name": "Exa Search", "transport": "streamable_http",
        "url": "https://mcp.exa.ai/mcp", "availability": "everyone",
        "auth_mode": "bearer",
    })
    store.set_user("exa", 7, enabled=True, credential="old-user-token")
    store.set_shared_credential("exa", "deployment-token")

    integration = store.list_for_user(7)[0]
    assert integration["has_credential"] is True
    assert integration["credential_source"] == "shared"
    assert "deployment-token" not in str(integration)
    assert "old-user-token" not in str(integration)


def test_personal_credential_remains_supported_without_shared_credential(tmp_path, monkeypatch):
    monkeypatch.setenv("SCOUT_SECRET_KEY", "test-secret")
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({
        "id": "personal", "name": "Personal MCP", "transport": "streamable_http",
        "url": "https://mcp.example.test/mcp", "availability": "everyone",
        "auth_mode": "bearer",
    })
    store.set_user("personal", 7, enabled=True, credential="user-token")

    integration = store.list_for_user(7)[0]
    assert integration["has_credential"] is True
    assert integration["credential_source"] == "user"


def test_mcp_tool_policy_and_delete_tombstone(tmp_path):
    store = McpStore(tmp_path / "mcp.sqlite")
    store.upsert_server({"id": "demo", "name": "Demo", "transport": "streamable_http", "url": "https://example.test/mcp"})
    store.upsert_tools("demo", [{"name": "read", "description": "Read", "inputSchema": {"type": "object"}}])
    assert store.set_tool_policy("demo", "read", read_only=True)
    assert store.list_tools("demo")[0]["read_only"] is True
    assert store.delete_server("demo")
    assert store.list_servers() == []


def test_bootstrap_reconciles_deploy_changes_without_overwriting_admin_edits(tmp_path):
    store = McpStore(tmp_path / "mcp.sqlite")
    original = {
        "id": "docs", "name": "Docs", "transport": "streamable_http",
        "url": "https://one.example/mcp",
    }
    assert store.import_bootstrap([original]) == 1

    store.upsert_server({**original, "url": "https://admin.example/mcp"})
    assert store.import_bootstrap([original]) == 0
    assert store.get_server("docs")["url"] == "https://admin.example/mcp"

    changed = {**original, "url": "https://two.example/mcp"}
    assert store.import_bootstrap([changed]) == 1
    assert store.get_server("docs")["url"] == "https://two.example/mcp"

    store.import_bootstrap([])
    assert store.list_servers() == []
