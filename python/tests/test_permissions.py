"""Tests for permission profiles."""

from types import SimpleNamespace

import pytest

from scout.permissions import resolve_profile
from scout.agent.tools import make_tools
from scout.retriever import BM25Retriever
from scout.config import AppConfig


def test_analyst_profile_disables_writes_and_shell():
    profile = resolve_profile("analyst")
    assert profile.disable_write_tools
    assert not profile.shell_enabled
    assert "write_file" not in profile.allowed_tools
    assert "exec_command" not in profile.allowed_tools
    assert "run_python" not in profile.allowed_tools
    assert "run_code" not in profile.allowed_tools
    assert "ask_user_choice" in profile.allowed_tools
    assert "present_files" in profile.allowed_tools


def test_admin_profile_allows_shared_write():
    profile = resolve_profile("admin")
    assert profile.allow_shared_write
    assert "write_file" in profile.allowed_tools
    assert "exec_command" in profile.allowed_tools
    assert "run_python" not in profile.allowed_tools
    assert "run_code" not in profile.allowed_tools
    assert "install_python_package" not in profile.allowed_tools
    assert "install_node_package" not in profile.allowed_tools
    assert "ask_user_choice" in profile.allowed_tools


def test_contributor_profile_has_shell_not_install_tools():
    profile = resolve_profile("contributor")
    assert "exec_command" in profile.allowed_tools
    assert "run_python" not in profile.allowed_tools
    assert "run_code" not in profile.allowed_tools
    assert "install_python_package" not in profile.allowed_tools
    assert "install_node_package" not in profile.allowed_tools
    assert "ask_user_choice" in profile.allowed_tools
    assert "present_files" in profile.allowed_tools


def test_make_tools_filters_by_profile():
    config = AppConfig()
    retriever = BM25Retriever(config)
    profile = resolve_profile("analyst")
    tools = make_tools(
        retriever, "/tmp",
        disable_write_tools=profile.disable_write_tools,
        allowed_tools=profile.allowed_tools,
    )
    names = {t.name for t in tools}
    assert "write_file" not in names
    assert "exec_command" not in names
    assert "run_python" not in names
    assert "run_code" not in names
    assert "install_python_package" not in names
    assert "read_file" in names
    assert "search_workspace" in names
    assert "filter_table" in names
    assert "read_pdf" not in names
    assert "ask_user_choice" in names
    assert "present_files" in names


@pytest.mark.asyncio
async def test_exec_command_delegates_before_enabled_health_is_warm():
    class FakeExecutionService:
        enabled = False
        _exec_cfg = SimpleNamespace(unified_shell=True)

        def __init__(self):
            self.called = False

        async def exec_command(self, cmd, *, workdir="", yield_time_ms=None, description=""):
            self.called = True
            assert cmd == "python3 histogram_generate.py --n 1000 --seed 42 --bins 30"
            return SimpleNamespace(text="ran")

    config = AppConfig()
    retriever = BM25Retriever(config)
    service = FakeExecutionService()
    tools = {
        t.name: t for t in make_tools(
            retriever,
            "/tmp",
            execution_service=service,
            allowed_tools=frozenset({"exec_command"}),
        )
    }

    result = await tools["exec_command"].ainvoke({
        "cmd": "python3 histogram_generate.py --n 1000 --seed 42 --bins 30",
    })

    assert result == "ran"
    assert service.called
