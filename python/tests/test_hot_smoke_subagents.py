"""Hot smoke: multi-agent against a live Scout server (Docker or local).

Intentionally minimal LLM usage — one parent turn that should spawn a single
background explore sub-agent, then a status poll. Skip unless explicitly enabled:

    SCOUT_HOT_SMOKE=1 SCOUT_BASE_URL=http://127.0.0.1:4200 \\
      pytest python/tests/test_hot_smoke_subagents.py -q

Optional auth for multi-user deployments:

    SCOUT_HOT_USER=admin SCOUT_HOT_PASSWORD=...
"""

from __future__ import annotations

import json
import os
import time

import httpx
import pytest

BASE = os.environ.get("SCOUT_BASE_URL", "http://127.0.0.1:4200").rstrip("/")
ENABLED = os.environ.get("SCOUT_HOT_SMOKE", "").strip() in {"1", "true", "yes"}

pytestmark = pytest.mark.skipif(
    not ENABLED,
    reason="Set SCOUT_HOT_SMOKE=1 to run live Docker/server multi-agent smoke",
)


def _headers(token: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _login(client: httpx.Client) -> str | None:
    user = os.environ.get("SCOUT_HOT_USER", "").strip()
    password = os.environ.get("SCOUT_HOT_PASSWORD", "").strip()
    if not user or not password:
        # Probe multi-user: if /health says multi_user and no creds, skip.
        health = client.get(f"{BASE}/health", timeout=15)
        if health.status_code == 200:
            data = health.json()
            if data.get("multi_user") and not data.get("auth_disabled"):
                pytest.skip("Multi-user server requires SCOUT_HOT_USER/SCOUT_HOT_PASSWORD")
        return None
    resp = client.post(
        f"{BASE}/api/login",
        json={"username": user, "password": password},
        timeout=30,
    )
    if resp.status_code != 200:
        # Try register-then-login for disposable smoke accounts.
        reg = client.post(
            f"{BASE}/api/register",
            json={"username": user, "password": password},
            timeout=30,
        )
        if reg.status_code not in {200, 201, 409}:
            pytest.fail(
                f"Login failed ({resp.status_code}): {resp.text[:200]}; "
                f"register failed ({reg.status_code}): {reg.text[:200]}"
            )
        resp = client.post(
            f"{BASE}/api/login",
            json={"username": user, "password": password},
            timeout=30,
        )
        if resp.status_code != 200:
            pytest.fail(f"Login failed after register: {resp.status_code} {resp.text[:300]}")
    return resp.json()["access_token"]


def _read_sse_events(resp: httpx.Response, max_seconds: float = 180.0) -> list[dict]:
    """Parse SSE lines from a streaming /chat response."""
    events: list[dict] = []
    deadline = time.time() + max_seconds
    event_type = None
    data_buf: list[str] = []
    for line in resp.iter_lines():
        if time.time() > deadline:
            break
        if line is None:
            continue
        if line.startswith("event:"):
            event_type = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_buf.append(line.split(":", 1)[1].strip())
        elif line == "" and data_buf:
            raw = "\n".join(data_buf)
            data_buf = []
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"raw": raw}
            if isinstance(payload, dict):
                if event_type and "type" not in payload:
                    payload["type"] = event_type
                events.append(payload)
            event_type = None
        if any(
            e.get("type") in {"response", "error", "interrupted"}
            for e in events[-3:]
        ) and event_type is None and not data_buf:
            # Prefer ending after a terminal response, but allow a short tail.
            if events and events[-1].get("type") in {"response", "error", "interrupted"}:
                # Keep reading briefly for trailing events, then stop if idle.
                pass
    return events


def test_subagent_event_stream_route():
    """Lifecycle SSE route returns its initial snapshot without an LLM call."""
    with httpx.Client(timeout=30.0) as client:
        token = _login(client)
        headers = _headers(token)
        create = client.post(f"{BASE}/sessions", headers=headers, json={}, timeout=60)
        assert create.status_code == 200, create.text[:400]
        session_id = create.json().get("sessionId") or create.json().get("session_id")
        assert session_id

        with client.stream(
            "GET",
            f"{BASE}/sessions/{session_id}/subagent-events",
            headers=headers,
            timeout=httpx.Timeout(15.0, connect=10.0),
        ) as event_resp:
            assert event_resp.status_code == 200, event_resp.read()[:400]
            event_lines = []
            for line in event_resp.iter_lines():
                event_lines.append(line)
                if line == "" and any(
                    item.startswith("data:") for item in event_lines
                ):
                    break
            assert any("subagents_snapshot" in line for line in event_lines)


def test_health_and_spawn_one_explore_subagent():
    """One careful multi-agent smoke: spawn a single explore agent, then list."""
    with httpx.Client(timeout=30.0) as client:
        health = client.get(f"{BASE}/health")
        assert health.status_code == 200, health.text
        token = _login(client)
        headers = _headers(token)

        # Create session (server assigns sessionId)
        create = client.post(
            f"{BASE}/sessions",
            headers=headers,
            json={},
            timeout=60,
        )
        assert create.status_code == 200, create.text[:400]
        session_id = create.json().get("sessionId") or create.json().get("session_id")
        assert session_id, create.text[:400]

        # Carefully worded prompt: one snoop sub-agent, list workspace, nothing else.
        message = (
            "Use spawn_subagent exactly once with agent_type=snoop and "
            "run_in_background=true. Description: 'List workspace'. "
            "Prompt for the sub-agent: 'List the top-level files in the workspace "
            "using list_files and report names only. Do not spawn agents.' "
            "After launching, briefly confirm you started it and stop. "
            "Do not spawn more than one sub-agent. Do not invent other tasks."
        )

        with client.stream(
            "POST",
            f"{BASE}/chat",
            headers=headers,
            json={"session_id": session_id, "message": message},
            timeout=httpx.Timeout(200.0, connect=30.0),
        ) as resp:
            assert resp.status_code == 200, resp.read()[:500]
            events = _read_sse_events(resp, max_seconds=180.0)

        assert events, "No SSE events received from /chat"
        errors = [e for e in events if e.get("type") == "error"]
        assert not errors, f"Chat errors: {errors[:2]}"

        tool_calls = [e for e in events if e.get("type") == "tool_call"]
        spawn_calls = [e for e in tool_calls if e.get("name") == "spawn_subagent"]
        # Soft assertion: models sometimes use different paths; still check API.
        tool_results = [e for e in events if e.get("type") == "tool_result"]
        spawn_results = [
            e for e in tool_results
            if e.get("name") == "spawn_subagent"
            or "async_launched" in str(e.get("output") or "")
            or "agent_id:" in str(e.get("output") or "")
        ]

        # Poll subagents endpoint (no extra LLM cost).
        deadline = time.time() + 120
        snapshot = None
        while time.time() < deadline:
            listed = client.get(
                f"{BASE}/sessions/{session_id}/subagents",
                headers=headers,
                timeout=30,
            )
            if listed.status_code == 200:
                snapshot = listed.json()
                agents = snapshot.get("subagents") or []
                if agents and all(
                    a.get("status") in {"completed", "failed", "stopped"}
                    for a in agents
                ):
                    break
                if agents and any(a.get("status") == "running" for a in agents):
                    time.sleep(2.0)
                    continue
                if agents:
                    break
            time.sleep(1.5)

        assert snapshot is not None, "Could not fetch /sessions/{id}/subagents"
        # If the model refused to spawn, still report what happened for debugging.
        if not spawn_calls and not spawn_results and not (snapshot.get("subagents") or []):
            response_texts = [
                e.get("content", "") for e in events if e.get("type") == "response"
            ]
            pytest.fail(
                "Model did not spawn a sub-agent in hot smoke. "
                f"tool_calls={[e.get('name') for e in tool_calls]}, "
                f"responses={response_texts[:1]!r}"
            )

        agents = snapshot.get("subagents") or []
        assert len(agents) <= 3, f"Spawned too many agents: {agents}"
        assert len(agents) >= 1, f"Expected at least one sub-agent, got {snapshot}"
        # Prefer explore, but accept general-purpose if model chose that.
        assert agents[0].get("status") in {
            "completed", "failed", "stopped", "running", "pending",
        }
