"""Integration tests for execution sandbox (requires bubblewrap when available)."""

import os
import shutil
from pathlib import Path

import pytest

from scout.config import AppConfig, ExecutionConfig
from scout.execution.launcher import bwrap_available
from scout.execution.local_backend import LocalSandboxBackend
from scout.execution.models import ExecutionPolicy, ExecutionRequest, NetworkPolicy
from scout.execution.policy import build_execution_environment

pytestmark = pytest.mark.skipif(not bwrap_available(), reason="bubblewrap not available")


@pytest.fixture
def workspace(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (shared / "team.txt").write_text("team data")
    return personal, shared


@pytest.mark.asyncio
async def test_python_reads_shared_not_other_user(workspace, tmp_path: Path):
    personal, shared = workspace
    other = tmp_path / "users" / "12"
    other.mkdir(parents=True)
    (other / "secret.txt").write_text("secret")

    cfg = ExecutionConfig(allow_insecure_local_fallback=False, timeout_seconds=30)
    backend = LocalSandboxBackend(cfg)

    policy = ExecutionPolicy(
        read_roots=(personal, shared),
        write_roots=(personal, personal / ".scout-cache"),
        denied_roots=(),
        network=NetworkPolicy(mode="deny"),
        timeout_seconds=30,
        max_output_bytes=100_000,
    )
    env = build_execution_environment(personal)

    # Read shared
    req = ExecutionRequest(
        execution_id="t1",
        user_id="1",
        session_id="s1",
        runtime="python",
        command=None,
        code=f"print(open({str(shared / 'team.txt')!r}).read())",
        cwd=personal,
        policy=policy,
        environment=env,
    )
    result = await backend.execute(req)
    assert "team data" in result.stdout

    # Cannot read other user
    req2 = ExecutionRequest(
        execution_id="t2",
        user_id="1",
        session_id="s1",
        runtime="python",
        command=None,
        code=f"print(open({str(other / 'secret.txt')!r}).read())",
        cwd=personal,
        policy=policy,
        environment=env,
    )
    result2 = await backend.execute(req2)
    assert result2.exit_code != 0 or "denied" in (result2.stdout + result2.stderr).lower() or "error" in (result2.stdout + result2.stderr).lower()


@pytest.mark.asyncio
async def test_backend_health_reports_isolation():
    backend = LocalSandboxBackend(ExecutionConfig())
    health = await backend.health()
    assert health.backend == "local-sandbox"
    assert health.isolation is True


@pytest.mark.asyncio
async def test_server_mode_refuses_without_worker():
    from scout.execution.service import ExecutionService
    from scout.config import load_config

    personal = Path("/tmp/scout-test-personal")
    personal.mkdir(exist_ok=True)
    config = AppConfig()
    config.execution = ExecutionConfig(
        enabled=True,
        backend="worker",
        worker_url="http://127.0.0.1:1",  # unreachable
    )
    svc = ExecutionService(
        config=config,
        guard=None,
        personal_dir=personal,
        shared_dir=None,
        user_id="1",
        session_id="s1",
        server_mode=True,
    )
    result = await svc.run_python("print(1)")
    assert "SANDBOX UNAVAILABLE" in result.text


@pytest.mark.asyncio
async def test_shell_can_run_python_module_pip(workspace):
    personal, _ = workspace
    cfg = ExecutionConfig(allow_insecure_local_fallback=False, timeout_seconds=30)
    backend = LocalSandboxBackend(cfg)
    sandbox_python = backend._persistent.sandbox_python
    env = build_execution_environment(personal, sandbox_python=sandbox_python)
    policy = ExecutionPolicy(
        read_roots=(personal, personal / ".scout-cache"),
        write_roots=(personal / ".scout-cache",),
        denied_roots=(),
        network=NetworkPolicy(mode="deny"),
        timeout_seconds=30,
        max_output_bytes=100_000,
    )
    req = ExecutionRequest(
        execution_id="pip-version",
        user_id="1",
        session_id="s1",
        runtime="shell",
        command=("python", "-m", "pip", "--version"),
        code=None,
        cwd=personal,
        policy=policy,
        environment=env,
        sandbox_python=sandbox_python,
    )
    result = await backend.execute(req)
    combined = (result.stdout or "") + (result.stderr or "")
    assert result.exit_code == 0, combined
    assert "pip" in combined.lower()


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get("SCOUT_TEST_NETWORK"), reason="Set SCOUT_TEST_NETWORK=1 for pip install integration")
async def test_pip_install_makes_package_importable_in_python(workspace):
    """Install a tiny package via shell, then import it in persistent Python."""
    personal, _ = workspace
    cfg = ExecutionConfig(allow_insecure_local_fallback=False, timeout_seconds=60)
    backend = LocalSandboxBackend(cfg)
    sandbox_python = backend._persistent.sandbox_python
    env = build_execution_environment(personal, sandbox_python=sandbox_python)
    policy = ExecutionPolicy(
        read_roots=(personal, personal / ".scout-cache"),
        write_roots=(personal / ".scout-cache",),
        denied_roots=(),
        network=NetworkPolicy(mode="deny"),
        timeout_seconds=60,
        max_output_bytes=100_000,
    )

    install_req = ExecutionRequest(
        execution_id="pip-install",
        user_id="1",
        session_id="s1",
        runtime="shell",
        command=("python", "-m", "pip", "install", "ascii-colors"),
        code=None,
        cwd=personal,
        policy=policy,
        environment=env,
        sandbox_python=sandbox_python,
    )
    install_result = await backend.execute(install_req)
    install_out = (install_result.stdout or "") + (install_result.stderr or "")
    assert install_result.exit_code == 0, install_out

    python_req = ExecutionRequest(
        execution_id="py-import",
        user_id="1",
        session_id="s1",
        runtime="python",
        command=None,
        code="import ascii_colors; print('import-ok')",
        cwd=personal,
        policy=policy,
        environment=env,
        persistent=True,
        scratch_dir=personal / ".scout-cache" / "session-scratch" / "s1",
        sandbox_python=sandbox_python,
    )
    python_result = await backend.execute(python_req)
    assert "import-ok" in (python_result.stdout or ""), python_result.stderr
