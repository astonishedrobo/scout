"""Unit tests for execution policy, env, grants, and change detection."""

import os
import time
from pathlib import Path

import pytest

from scout.config import ExecutionConfig
from scout.agent.tools import make_tools
from scout.execution.changes import diff_snapshots, snapshot_writable_roots
from scout.execution.container_backend import _base_run_args
from scout.execution.env import ALLOWED_ENV_KEYS, build_execution_env
from scout.execution.grants import CapabilityGrantStore
from scout.execution.models import ExecutionRequest, ExecutionResult
from scout.execution.orchestrator import ExecutionOrchestrator
from scout.execution.policy import build_execution_policy, is_ignored_execution_path, safe_read_bind_paths
from scout.execution.unified_exec import UnifiedExecResponse, _ProcessEntry, _changes_and_artifacts
from scout.execution.worker_roots import derive_user_roots


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


def test_worker_roots_use_canonical_sandbox_paths(tmp_path: Path, monkeypatch):
    users = tmp_path / "users"
    shared = tmp_path / "shared"
    (users / "42").mkdir(parents=True)
    shared.mkdir()
    monkeypatch.setenv("SCOUT_WORKSPACE_USERS", str(users))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED", str(shared))

    layout = derive_user_roots("42")

    assert layout.personal_root == (users / "42").resolve()
    assert layout.shared_root == shared.resolve()
    assert layout.in_sandbox_personal == Path("/workspace")
    assert layout.in_sandbox_shared == Path("/shared")


def test_container_run_args_mount_user_at_workspace_and_shared_at_shared(tmp_path: Path, monkeypatch):
    users = tmp_path / "users"
    shared = tmp_path / "shared"
    personal = users / "7"
    personal.mkdir(parents=True)
    shared.mkdir()
    # Worker and host are the same tree (non-nested).
    monkeypatch.setenv("SCOUT_WORKSPACE_USERS", str(users))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED", str(shared))
    monkeypatch.setenv("SCOUT_WORKSPACE_USERS_HOST", str(users))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED_HOST", str(shared))
    monkeypatch.setenv("SCOUT_CONTAINER_ENGINE", "sh")
    monkeypatch.setenv("SCOUT_SANDBOX_IMAGE", "scout:test")

    policy = build_execution_policy(
        personal_dir=personal,
        shared_dir=shared,
        config=ExecutionConfig(),
        personal_write=True,
    )
    req = ExecutionRequest(
        execution_id="e1",
        user_id="7",
        session_id="s1",
        runtime="shell",
        command=("/bin/true",),
        code=None,
        cwd=personal,
        policy=policy,
        environment={},
        sandbox_cwd=Path("/workspace"),
        sandbox_personal_dir=Path("/workspace"),
        sandbox_shared_dir=Path("/shared"),
    )

    args, env = _base_run_args(req, proxy_url=None, interactive=False)

    assert "-w" in args
    assert args[args.index("-w") + 1] == "/workspace"
    assert "-v" in args
    mounts = [args[i + 1] for i, value in enumerate(args) if value == "-v"]
    assert f"{personal}:/workspace:rw" in mounts
    assert f"{shared}:/shared:ro" in mounts
    assert env["HOME"].startswith("/workspace/.scout-cache/")
    assert env["PIP_TARGET"] == "/workspace/.scout-cache/python-packages"
    assert env["MPLCONFIGDIR"] == "/workspace/.scout-cache/matplotlib"
    assert "/srv/scout-source" not in " ".join(args)
    assert "/srv/scout-source" not in " ".join(env.values())


def test_container_run_args_nested_host_ne_worker(tmp_path: Path, monkeypatch):
    """Host bind sources must not be used as sandbox env bases."""
    worker_users = tmp_path / "worker" / "users"
    worker_shared = tmp_path / "worker" / "shared"
    host_users = tmp_path / "host" / "users"
    host_shared = tmp_path / "host" / "shared"
    personal = worker_users / "9"
    personal.mkdir(parents=True)
    worker_shared.mkdir(parents=True)
    host_users.mkdir(parents=True)
    host_shared.mkdir(parents=True)

    monkeypatch.setenv("SCOUT_WORKSPACE_USERS", str(worker_users))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED", str(worker_shared))
    monkeypatch.setenv("SCOUT_WORKSPACE_USERS_HOST", str(host_users))
    monkeypatch.setenv("SCOUT_WORKSPACE_SHARED_HOST", str(host_shared))
    monkeypatch.setenv("SCOUT_CONTAINER_ENGINE", "sh")
    monkeypatch.setenv("SCOUT_SANDBOX_IMAGE", "scout:test")

    policy = build_execution_policy(
        personal_dir=personal,
        shared_dir=worker_shared,
        config=ExecutionConfig(),
        personal_write=True,
        allow_shared_write=True,
    )
    req = ExecutionRequest(
        execution_id="e2",
        user_id="9",
        session_id="s2",
        runtime="shell",
        command=("/bin/true",),
        code=None,
        cwd=personal,
        policy=policy,
        environment={},
        sandbox_cwd=Path("/workspace"),
        sandbox_personal_dir=Path("/workspace"),
        sandbox_shared_dir=Path("/shared"),
    )

    args, env = _base_run_args(req, proxy_url=None, interactive=False)
    mounts = [args[i + 1] for i, value in enumerate(args) if value == "-v"]

    # Mounts use host sources.
    assert f"{host_users / '9'}:/workspace:rw" in mounts
    assert f"{host_shared}:/shared:rw" in mounts
    # Env is sandbox-only — never worker or host absolute trees.
    joined = " ".join(env.values())
    assert env["HOME"] == "/workspace/.scout-cache/home"
    assert env["UV_CACHE_DIR"] == "/workspace/.scout-cache/uv"
    assert env["PYTHONPATH"] == "/workspace/.scout-cache/python-packages"
    assert str(worker_users) not in joined
    assert str(host_users) not in joined
    assert "/srv/scout-source" not in joined
    # PATH must not be path-rewritten into nonsense.
    assert ":" in env["PATH"] or env["PATH"].startswith("/usr")
    # Cache materialized on the worker-visible volume.
    assert (personal / ".scout-cache" / "python-packages").is_dir()


def test_file_tools_resolve_canonical_workspace_and_shared_paths(tmp_path: Path):
    personal = tmp_path / "users" / "7"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "note.txt").write_text("personal")
    (shared / "shared.txt").write_text("shared")

    class DummyRetriever:
        def search(self, query, top_k=5):
            return []

    class DummyGuard:
        _shared = shared

        def is_read_denied(self, path):
            p = Path(path).resolve()
            return not (
                str(p).startswith(str(personal.resolve()))
                or str(p).startswith(str(shared.resolve()))
            )

        def is_write_denied(self, path):
            p = Path(path).resolve()
            return not str(p).startswith(str(personal.resolve()))

    tools = {
        tool.name: tool
        for tool in make_tools(
            DummyRetriever(),
            personal,
            guard=DummyGuard(),
            user_id="7",
            use_memories=False,
            allow_request_permissions=False,
            disable_write_tools=True,
            allowed_tools=frozenset({"read_file", "list_files"}),
        )
    }

    assert tools["read_file"].invoke({"path": "/workspace/note.txt"}) == "personal"
    assert tools["read_file"].invoke({"path": "note.txt"}) == "personal"
    assert tools["read_file"].invoke({"path": "/shared/shared.txt"}) == "shared"
    assert "note.txt" in tools["list_files"].invoke({"directory": "/workspace"})


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
async def test_run_python_uses_canonical_sandbox_paths_without_alias_preamble(tmp_path: Path):
    personal = tmp_path / "users" / "7"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    seen: dict[str, object] = {}

    class FakeBackend:
        async def execute(self, request, *, proxy_url=None):
            seen["sandbox_cwd"] = request.sandbox_cwd
            seen["sandbox_personal_dir"] = request.sandbox_personal_dir
            seen["sandbox_shared_dir"] = request.sandbox_shared_dir
            seen["code"] = request.code
            return ExecutionResult(
                exit_code=0,
                stdout="ok",
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

    result = await orchestrator.run_python("print('ok')")

    assert result.text == "ok"
    assert seen["sandbox_personal_dir"] == Path("/workspace")
    assert seen["sandbox_shared_dir"] == Path("/shared")
    assert str(seen["sandbox_cwd"]).startswith("/workspace")
    assert "_SCOUT_WORKSPACE_PATH_ALIASES_READY" not in str(seen["code"])


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
async def test_exec_command_workdir_uses_canonical_paths(tmp_path: Path):
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

    await orchestrator.exec_command("ls", workdir="/workspace")
    assert seen["cwd"] == personal.resolve()

    await orchestrator.exec_command("ls", workdir="/workspace/sub")
    assert seen["cwd"] == (personal / "sub").resolve()

    await orchestrator.exec_command("ls", workdir="/shared")
    assert seen["cwd"] == shared.resolve()

    # A bare subdirectory name still resolves under the personal root.
    await orchestrator.exec_command("ls", workdir="data")
    assert seen["cwd"] == (personal / "data").resolve()


@pytest.mark.asyncio
async def test_exec_command_preserves_non_workspace_paths_in_command(tmp_path: Path):
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
    command = "python3 analyze.py data/climate.csv"

    await orchestrator.exec_command(command)

    assert seen["command"] == command


@pytest.mark.asyncio
async def test_exec_command_does_not_preprocess_legacy_path_arguments(tmp_path: Path):
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

    command = "python3 analyze.py /app/workspace/users/7/data.csv"
    result = await orchestrator.exec_command(command, workdir="/workspace")

    assert result.text == "ok"
    assert seen["command"] == command


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
    assert env["UV_CACHE_DIR"] == str(cache / "uv")


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


def test_unified_exec_artifact_paths_are_relative_to_workspace_not_command_cwd(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    subdir = personal / "workspace"
    subdir.mkdir(parents=True)
    artifact_path = subdir / "histogram.png"
    artifact_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    policy = build_execution_policy(
        personal_dir=personal,
        shared_dir=None,
        config=ExecutionConfig(),
        personal_write=True,
    )
    entry = _ProcessEntry(
        process_id=1,
        user_id="1",
        session_id="s1",
        execution_id="e1",
        command="python sample_and_plot.py",
        cwd=subdir,
        workspace_root=personal,
        policy=policy,
        staging_dir=None,
        work_dir=None,
        proc=None,  # type: ignore[arg-type]
        master_fd=-1,
        buffer=None,  # type: ignore[arg-type]
        output_notify=None,  # type: ignore[arg-type]
        reader_thread=None,  # type: ignore[arg-type]
        tool_call_id="",
        before_snapshot={},
    )

    _changes, artifacts = _changes_and_artifacts(entry)

    assert [artifact["path"] for artifact in artifacts] == ["workspace/histogram.png"]


def test_is_ignored_execution_path(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    assert is_ignored_execution_path(root / ".scout-cache" / "x", root)
    assert is_ignored_execution_path(root / ".scout-executions" / "abc" / "work" / "f", root)
    assert is_ignored_execution_path(root / ".local" / "PIL" / "Image.py", root)
    assert is_ignored_execution_path(root / "pkg" / "foo.dist-info" / "METADATA", root)
    assert not is_ignored_execution_path(root / "output.png", root)
    assert not is_ignored_execution_path(root / ".gitignore", root)
    assert not is_ignored_execution_path(root / "sample_histogram.py", root)


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
