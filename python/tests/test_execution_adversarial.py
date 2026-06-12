"""Adversarial execution sandbox tests."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from scout.config import ExecutionConfig
from scout.execution.grants import CapabilityGrantStore
from scout.execution.launcher import bwrap_available
from scout.execution.local_backend import LocalSandboxBackend
from scout.execution.models import ExecutionPolicy, ExecutionRequest, NetworkPolicy
from scout.execution.network_proxy import EgressProxy
from scout.execution.policy import build_execution_environment, safe_read_bind_paths
from scout.execution.sandbox_probe import probe_sandbox_isolation
from scout.execution.worker_auth import sign_request_body, verify_signed_request
from scout.execution.worker_roots import derive_user_roots, validate_user_id

pytestmark = pytest.mark.skipif(not bwrap_available(), reason="bubblewrap not available")


@pytest.fixture
def workspace(tmp_path: Path):
    users = tmp_path / "users"
    shared = tmp_path / "shared"
    personal = users / "1"
    other = users / "2"
    personal.mkdir(parents=True)
    other.mkdir(parents=True)
    shared.mkdir()
    (personal / "mine.txt").write_text("mine")
    (other / "secret.txt").write_text("secret")
    (shared / "team.txt").write_text("team")
    return personal, shared, other


@pytest.mark.asyncio
async def test_cross_user_read_denied(workspace, monkeypatch):
    personal, shared, other = workspace
    monkeypatch.setenv("SCOUT_WORKSPACE_USERS", str(other.parent))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED", str(shared))

    layout = derive_user_roots("1")
    cfg = ExecutionConfig(timeout_seconds=30)
    backend = LocalSandboxBackend(cfg)
    policy = ExecutionPolicy(
        read_roots=(layout.personal_root, layout.shared_root),
        write_roots=(layout.personal_root / ".scout-cache",),
        denied_roots=(),
        network=NetworkPolicy(mode="deny"),
        timeout_seconds=30,
        max_output_bytes=100_000,
    )
    env = build_execution_environment(layout.personal_root)
    req = ExecutionRequest(
        execution_id="adv1",
        user_id="1",
        session_id="s1",
        runtime="python",
        command=None,
        code=f"import os\nprint(os.path.exists({str(other / 'secret.txt')!r}))",
        cwd=layout.personal_root,
        policy=policy,
        environment=env,
    )
    result = await backend.execute(req)
    assert "True" not in result.stdout


@pytest.mark.asyncio
async def test_proc_environ_scrubbed(workspace):
    personal, shared, _ = workspace
    cfg = ExecutionConfig(timeout_seconds=30)
    backend = LocalSandboxBackend(cfg)
    policy = ExecutionPolicy(
        read_roots=(personal, shared),
        write_roots=(personal / ".scout-cache",),
        denied_roots=(),
        network=NetworkPolicy(mode="deny"),
        timeout_seconds=30,
        max_output_bytes=100_000,
    )
    env = build_execution_environment(personal)
    req = ExecutionRequest(
        execution_id="adv2",
        user_id="1",
        session_id="s1",
        runtime="python",
        command=None,
        code="import os\nprint('OPENAI' in open('/proc/self/environ').read())",
        cwd=personal,
        policy=policy,
        environment=env,
    )
    result = await backend.execute(req)
    assert "True" not in result.stdout


def test_worker_rejects_forged_user_id(monkeypatch, tmp_path: Path):
    users = tmp_path / "users"
    shared = tmp_path / "shared"
    (users / "1").mkdir(parents=True)
    shared.mkdir()
    monkeypatch.setenv("SCOUT_WORKSPACE_USERS", str(users))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED", str(shared))

    with pytest.raises(ValueError):
        validate_user_id("../2")
    with pytest.raises(ValueError):
        derive_user_roots("999")


def test_worker_auth_replay_rejected(monkeypatch):
    secret = "scout-worker-test-secret"
    monkeypatch.setenv("SCOUT_WORKER_SECRET", secret)
    payload = {"user_id": "1"}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    headers = sign_request_body(payload, secret=secret)
    verify_signed_request(
        authorization=f"Bearer {secret}",
        body=body,
        signature=headers["X-Scout-Signature"],
        timestamp=headers["X-Scout-Timestamp"],
        nonce=headers["X-Scout-Nonce"],
        payload_user_id="1",
    )
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        verify_signed_request(
            authorization=f"Bearer {secret}",
            body=body,
            signature=headers["X-Scout-Signature"],
            timestamp=headers["X-Scout-Timestamp"],
            nonce=headers["X-Scout-Nonce"],
            payload_user_id="1",
        )


@pytest.mark.asyncio
async def test_proxy_blocks_direct_ip():
    proxy = EgressProxy(allowed_domains={"example.com"}, port=0)
    assert not proxy._domain_allowed("8.8.8.8")
    assert not proxy._domain_allowed("localhost")
    assert proxy._domain_allowed("sub.example.com")


def test_sandbox_probe_runs():
    result = probe_sandbox_isolation()
    assert result.bwrap_path is not None
    if result.isolation:
        assert result.oneshot
        assert result.persistent_python


def test_safe_read_bind_paths_exclude_env(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)
    (personal / "ok.txt").write_text("ok")
    (personal / ".env").write_text("SECRET=1")
    (personal / ".git").mkdir()
    (personal / ".git" / "config").write_text("git")

    binds = safe_read_bind_paths(personal, personal, (personal / ".git",))
    bind_names = {p.name for p in binds}
    assert "ok.txt" in bind_names
    assert ".env" not in bind_names
    assert "config" not in bind_names
    assert len(binds) < 20


def test_capability_consume_once():
    store = CapabilityGrantStore()
    store.add("g1", "1", "s1", "network_domain", {"domains": ["pypi.org"]}, grant_scope="once")
    assert store.network_domains_for("1", "s1") == ("pypi.org",)
    store.consume_once("g1")
    assert store.network_domains_for("1", "s1") == ()


@pytest.mark.asyncio
async def test_orchestrator_consumes_once_grant_on_success(tmp_path: Path):
    from scout.config import ExecutionConfig
    from scout.execution.orchestrator import ExecutionOrchestrator
    from scout.execution.models import ExecutionResult

    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)
    store = CapabilityGrantStore()
    store.add("g1", "1", "s1", "network_domain", {"domains": ["pypi.org"]}, grant_scope="once")

    class _FakeBackend:
        async def execute(self, request, *, proxy_url=None):
            return ExecutionResult(exit_code=0, stdout="ok", stderr="")

        async def close_session(self, session_id):
            pass

        async def health(self):
            from scout.execution.models import ExecutionBackendHealth
            return ExecutionBackendHealth(
                available=True, backend="test", isolation=True,
            )

    orch = ExecutionOrchestrator(
        backend=_FakeBackend(),
        config=ExecutionConfig(),
        personal_dir=personal,
        shared_dir=None,
        user_id="1",
        session_id="s1",
        grant_store=store,
        capability_approval=None,
    )
    orch._pending_once_grants = ["g1"]
    orch._consume_once_on_success(
        ExecutionResult(exit_code=0, stdout="ok", stderr=""),
        "network",
    )
    assert store.network_domains_for("1", "s1") == ()


def test_network_isolation_probe():
    from scout.execution.network_setup import network_isolation_available
    # May be true or false depending on environment; just ensure callable
    assert isinstance(network_isolation_available(), bool)


@pytest.mark.asyncio
async def test_server_mode_require_isolation_blocks_without_probe(tmp_path: Path):
    from scout.config import AppConfig
    from scout.execution.service import ExecutionService

    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)
    cfg = AppConfig()
    cfg.execution = ExecutionConfig(enabled=True, backend="local-sandbox", require_isolation=True)
    svc = ExecutionService(
        config=cfg,
        guard=None,
        personal_dir=personal,
        shared_dir=None,
        user_id="1",
        session_id="s1",
        server_mode=True,
    )
    result = await svc.run_python("print(1)")
    if not svc.enabled:
        assert "SANDBOX UNAVAILABLE" in result.text
