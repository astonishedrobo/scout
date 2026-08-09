from __future__ import annotations

from scout.server.app import _resolve_mcp_bootstrap_credentials


def _validate(item):
    return {
        "id": item["id"],
        "name": item["name"],
        "transport": "streamable_http",
        "url": item["url"],
        "availability": "everyone",
        "enabled": item.get("enabled", True),
        "auth_mode": item.get("auth_mode", "none"),
    }


def _exa(*, enabled=True):
    return {
        "id": "exa",
        "name": "Exa Search",
        "transport": "streamable_http",
        "url": "https://mcp.exa.ai/mcp?tools=web_search_exa",
        "availability": "everyone",
        "enabled": enabled,
        "auth_mode": "bearer",
        "credential_env": "EXA_API_KEY",
    }


def test_bootstrap_resolves_credential_env_separately_from_definition():
    definitions, credentials = _resolve_mcp_bootstrap_credentials(
        [_exa()], _validate, {"EXA_API_KEY": "test-secret"}
    )

    assert [definition["id"] for definition in definitions] == ["exa"]
    assert "credential_env" not in definitions[0]
    assert credentials == {"exa": "test-secret"}


def test_enabled_bootstrap_is_skipped_when_credential_env_is_missing(caplog):
    definitions, credentials = _resolve_mcp_bootstrap_credentials([_exa()], _validate, {})

    assert definitions == []
    assert credentials == {}
    assert "EXA_API_KEY is not set" in caplog.text
    assert "test-secret" not in caplog.text


def test_disabled_bootstrap_survives_without_credential_and_clears_it():
    definitions, credentials = _resolve_mcp_bootstrap_credentials(
        [_exa(enabled=False)], _validate, {}
    )

    assert [definition["id"] for definition in definitions] == ["exa"]
    assert credentials == {"exa": None}


def test_credential_env_requires_bearer_authentication(caplog):
    item = {**_exa(), "auth_mode": "none"}
    definitions, credentials = _resolve_mcp_bootstrap_credentials(
        [item], _validate, {"EXA_API_KEY": "test-secret"}
    )

    assert definitions == []
    assert credentials == {}
    assert "requires bearer authentication" in caplog.text
