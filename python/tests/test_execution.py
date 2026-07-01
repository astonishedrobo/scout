"""Unit tests for execution policy, env, grants, and change detection."""

import os
import builtins
import contextlib
import io
import time
from pathlib import Path

import pytest

from scout.config import ExecutionConfig
from scout.execution.changes import diff_snapshots, snapshot_writable_roots
from scout.execution.env import ALLOWED_ENV_KEYS, build_execution_env
from scout.execution.grants import CapabilityGrantStore
from scout.execution.models import ExecutionResult
from scout.execution.orchestrator import ExecutionOrchestrator
from scout.execution.policy import build_execution_policy, is_ignored_execution_path, safe_read_bind_paths
from scout.execution.unified_exec import UnifiedExecResponse


def test_policy_builder_user_workspace(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    cfg = ExecutionConfig()

    policy = build_execution_policy(
        personal_dir=personal,
        shared_dir=shared,
        config=cfg,
    )
    assert personal in policy.read_roots
    assert shared in policy.read_roots
    cache = personal / ".scout-cache"
    assert cache in policy.write_roots
    assert personal not in policy.write_roots
    assert shared not in policy.write_roots


def test_policy_staging_write_root(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)
    staging = personal / ".scout-executions" / "abc" / "work"
    staging.mkdir(parents=True)

    policy = build_execution_policy(
        personal_dir=personal,
        shared_dir=None,
        config=ExecutionConfig(),
        staging_dir=staging,
    )
    assert staging in policy.write_roots
    assert personal not in policy.write_roots


def test_persistent_policy_uses_stable_scratch_write_root(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    staging = personal / ".scout-executions" / "abc" / "work"
    scratch = personal / ".scout-cache" / "session-scratch" / "s1"
    staging.mkdir(parents=True)
    scratch.mkdir(parents=True)

    policy = build_execution_policy(
        personal_dir=personal,
        shared_dir=None,
        config=ExecutionConfig(),
        staging_dir=staging,
        scratch_dir=scratch,
        persistent=True,
    )

    assert scratch in policy.write_roots
    assert staging not in policy.write_roots
    assert personal not in policy.write_roots


@pytest.mark.asyncio
async def test_run_python_promotes_relative_output_from_stable_scratch(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)

    class FakeBackend:
        async def execute(self, request, *, proxy_url=None):
            assert request.persistent
            assert request.scratch_dir is not None
            assert "_scout_os.chdir(_SCOUT_PYTHON_WORKDIR)" in request.code
            (request.scratch_dir / "plot.png").write_bytes(b"png")
            return ExecutionResult(exit_code=0, stdout="ok", stderr="", persistent=True)

    async def approve(*_):
        return "yes", ""

    orchestrator = ExecutionOrchestrator(
        backend=FakeBackend(),
        config=ExecutionConfig(),
        personal_dir=personal,
        shared_dir=None,
        user_id="1",
        session_id="s1",
        grant_store=CapabilityGrantStore(),
        promotion_approval=approve,
    )

    result = await orchestrator.run_python("print('ok')")

    assert result.text == "ok"
    assert (personal / "plot.png").read_bytes() == b"png"
    assert any(artifact["name"] == "plot.png" for artifact in result.artifacts)


@pytest.mark.asyncio
async def test_run_python_translates_workspace_paths_from_scratch(tmp_path: Path):
    personal = tmp_path / "users" / "7"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "data.txt").write_text("personal-data")
    (shared / "shared.txt").write_text("shared-data")

    class FakeBackend:
        async def execute(self, request, *, proxy_url=None):
            original_cwd = Path.cwd()
            original_open = builtins.open
            original_io_open = io.open
            original_stat = os.stat
            original_lstat = os.lstat
            original_listdir = os.listdir
            original_scandir = os.scandir
            stdout = io.StringIO()
            try:
                os.chdir(request.cwd)
                with contextlib.redirect_stdout(stdout):
                    exec(request.code, {})
            finally:
                os.chdir(original_cwd)
                builtins.open = original_open
                io.open = original_io_open
                os.stat = original_stat
                os.lstat = original_lstat
                os.listdir = original_listdir
                os.scandir = original_scandir
            return ExecutionResult(
                exit_code=0,
                stdout=stdout.getvalue().strip(),
                stderr="",
                persistent=True,
            )

    orchestrator = ExecutionOrchestrator(
        backend=FakeBackend(),
        config=ExecutionConfig(),
        personal_dir=personal,
        shared_dir=shared,
        user_id="7",
        session_id="s1",
        grant_store=CapabilityGrantStore(),
    )

    result = await orchestrator.run_python(
        "\n".join([
            "from pathlib import Path",
            "print(Path('workspace/data.txt').exists())",
            "print(open('/app/workspace/users/7/data.txt').read())",
            "print(Path('/workspace/shared/shared.txt').read_text())",
        ])
    )

    assert result.text.splitlines() == ["True", "personal-data", "shared-data"]


@pytest.mark.asyncio
async def test_exec_command_builds_shell_policy_without_persistent_name_error(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)

    class FakeBackend:
        async def exec_command(self, request):
            assert request.command == "python3 histogram_generate.py --n 1000 --seed 42 --bins 30"
            assert request.policy.write_roots
            return UnifiedExecResponse(
                output="ok",
                wall_time_seconds=0.01,
                exit_code=0,
                alive=False,
            )

    orchestrator = ExecutionOrchestrator(
        backend=FakeBackend(),
        config=ExecutionConfig(),
        personal_dir=personal,
        shared_dir=None,
        user_id="1",
        session_id="s1",
        grant_store=CapabilityGrantStore(),
        personal_write=True,
    )

    result = await orchestrator.exec_command(
        "python3 histogram_generate.py --n 1000 --seed 42 --bins 30"
    )

    assert result.text == "ok"


@pytest.mark.asyncio
async def test_exec_command_workdir_workspace_alias_resolves_to_personal_root(tmp_path: Path):
    """workdir="workspace" must map to the personal root, not a nested dir.

    The file tools and prompt present the workspace as ``workspace/``, so the
    model passes ``workdir="workspace"``. If that joins to ``<personal>/workspace``
    outputs land one level too deep and the artifact endpoint 404s.
    """
    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)
    shared = tmp_path / "shared"
    shared.mkdir()

    seen: dict[str, Path] = {}

    class FakeBackend:
        async def exec_command(self, request):
            seen["cwd"] = Path(request.cwd)
            return UnifiedExecResponse(output="ok", wall_time_seconds=0.01, exit_code=0, alive=False)

    orchestrator = ExecutionOrchestrator(
        backend=FakeBackend(),
        config=ExecutionConfig(),
        personal_dir=personal,
        shared_dir=shared,
        user_id="1",
        session_id="s1",
        grant_store=CapabilityGrantStore(),
        personal_write=True,
    )

    await orchestrator.exec_command("ls", workdir="workspace")
    assert seen["cwd"] == personal.resolve()

    await orchestrator.exec_command("ls", workdir="workspace/users/1/sub")
    assert seen["cwd"] == (personal / "sub").resolve()

    await orchestrator.exec_command("ls", workdir="shared")
    assert seen["cwd"] == shared.resolve()

    # A bare subdirectory name still resolves under the personal root.
    await orchestrator.exec_command("ls", workdir="data")
    assert seen["cwd"] == (personal / "data").resolve()


@pytest.mark.asyncio
async def test_exec_command_translates_file_tool_paths_in_command(tmp_path: Path):
    personal = tmp_path / "users" / "7"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    seen: dict[str, str] = {}

    class FakeBackend:
        async def exec_command(self, request):
            seen["command"] = request.command
            return UnifiedExecResponse(output="ok", wall_time_seconds=0.01, exit_code=0, alive=False)

    orchestrator = ExecutionOrchestrator(
        backend=FakeBackend(),
        config=ExecutionConfig(),
        personal_dir=personal,
        shared_dir=shared,
        user_id="7",
        session_id="s1",
        grant_store=CapabilityGrantStore(),
        personal_write=True,
    )

    await orchestrator.exec_command(
        "python3 analyze.py workspace/shared/data/climate.csv "
        "shared/other.csv workspace/input.csv /workspace/users/7/report.csv"
    )

    assert seen["command"] == (
        f"python3 analyze.py {shared}/data/climate.csv "
        f"{shared}/other.csv {personal}/input.csv {personal}/report.csv"
    )


def test_env_allowlist_removes_secrets(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    monkeypatch.setenv("SCOUT_SECRET_KEY", "secret")
    monkeypatch.setenv("DATABASE_URL", "postgres://secret")
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("LANG", "en_US.UTF-8")

    cache = Path("/tmp/scout-test-cache")
    env = build_execution_env(home=cache / "home", cache_dir=cache)

    assert "OPENAI_API_KEY" not in env
    assert "SCOUT_SECRET_KEY" not in env
    assert "DATABASE_URL" not in env
    assert env.get("PATH") == "/usr/bin"
    assert env.get("LANG") == "en_US.UTF-8"


def test_capability_grants_expire():
    store = CapabilityGrantStore(default_ttl_seconds=0.01)
    store.add("g1", "1", "s1", "network_domain", {"domains": ["pypi.org"]})
    assert store.network_domains_for("1", "s1") == ("pypi.org",)
    time.sleep(0.02)
    assert store.network_domains_for("1", "s1") == ()


def test_capability_grants_scoped_to_session():
    store = CapabilityGrantStore()
    store.add("g1", "1", "s1", "network_domain", {"domains": ["pypi.org"]}, grant_scope="session")
    store.add("g2", "1", "s2", "network_domain", {"domains": ["npmjs.org"]}, grant_scope="session")
    assert store.network_domains_for("1", "s1") == ("pypi.org",)
    assert store.network_domains_for("1", "s2") == ("npmjs.org",)


def test_change_detector_ignores_cache(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    cache = personal / ".scout-cache"
    personal.mkdir(parents=True)
    cache.mkdir()
    (personal / "output.txt").write_text("v1")

    before = snapshot_writable_roots((personal,), workspace_root=personal)
    (cache / "matplotlib" / "fontlist.json").parent.mkdir(parents=True, exist_ok=True)
    (cache / "matplotlib" / "fontlist.json").write_text("{}")
    (personal / "output.txt").write_text("v2")

    after = snapshot_writable_roots((personal,), workspace_root=personal)
    changes = diff_snapshots(before, after, (personal,), workspace_root=personal)
    paths = [c.path for c in changes]
    assert any("output.txt" in p for p in paths)
    assert not any(".scout-cache" in p for p in paths)


def test_is_ignored_execution_path():
    root = Path("/ws/users/1")
    assert is_ignored_execution_path(root / ".scout-cache" / "x", root)
    assert is_ignored_execution_path(root / ".scout-executions" / "abc" / "work" / "f", root)
    assert not is_ignored_execution_path(root / "output.png", root)


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


def test_safe_read_bind_paths_skips_node_modules_and_binds_dirs(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "readme.md").write_text("hi")
    pkg = root / "packages"
    pkg.mkdir()
    (pkg / "main.py").write_text("print(1)")
    nm = root / "node_modules"
    nm.mkdir()
    for i in range(200):
        (nm / f"file{i}.js").write_text("x")

    binds = safe_read_bind_paths(root, root, ())
    bind_names = {p.name for p in binds}
    assert "packages" in bind_names
    assert "readme.md" in bind_names
    assert "node_modules" not in bind_names
    assert len(binds) < 10


def test_build_bwrap_argv_stays_under_limit_for_repo_like_tree(tmp_path: Path):
    from scout.execution.launcher import _estimate_argv_bytes, build_bwrap_command
    from scout.execution.models import ExecutionPolicy, NetworkPolicy
    from scout.execution.policy import build_execution_environment

    root = tmp_path / "repo"
    root.mkdir()
    (root / "README.md").write_text("hi")
    py = root / "python"
    py.mkdir()
    (py / "main.py").write_text("print(1)")
    nm = root / "node_modules"
    nm.mkdir()
    for i in range(500):
        (nm / f"mod{i}.js").write_text("x")

    policy = build_execution_policy(
        personal_dir=root,
        shared_dir=None,
        config=ExecutionConfig(),
        persistent=True,
    )
    env = build_execution_environment(root)
    cmd = build_bwrap_command(
        ["python3", "-c", "print(1)"],
        cwd=root,
        env=env,
        policy=policy,
        workspace_root=root,
    )
    assert _estimate_argv_bytes(cmd) < 2 * 1024 * 1024


def test_check_bwrap_argv_limit_raises_with_clear_error():
    from scout.execution.launcher import _check_bwrap_argv_limit

    huge = ["bwrap", *["--ro-bind", "/x", "/x"] * 200_000]
    with pytest.raises(RuntimeError, match="Sandbox command line too large"):
        _check_bwrap_argv_limit(huge)
