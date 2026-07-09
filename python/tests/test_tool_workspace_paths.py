from pathlib import Path

from scout.agent.file_guard import WorkspaceGuard
from scout.agent.tools import make_tools
from scout.config import AppConfig
from scout.retriever import BM25Retriever


def _tools(personal: Path, shared: Path):
    retriever = BM25Retriever(AppConfig())
    guard = WorkspaceGuard(personal, shared)
    return {
        tool.name: tool
        for tool in make_tools(
            retriever,
            personal,
            guard=guard,
            user_id="1",
            use_memories=False,
            allow_request_permissions=False,
        )
    }


def test_read_file_maps_bare_relative_paths_to_personal_workspace(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "report.txt").write_text("personal report")

    tools = _tools(personal, shared)

    assert tools["read_file"].invoke({"path": "report.txt"}) == "personal report"


def test_read_file_maps_workspace_absolute_path_to_personal_workspace(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "report.txt").write_text("personal report")

    tools = _tools(personal, shared)

    assert tools["read_file"].invoke({"path": "/workspace/report.txt"}) == "personal report"


def test_read_file_maps_shared_absolute_path_to_shared_workspace(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (shared / "report.txt").write_text("shared report")

    tools = _tools(personal, shared)

    assert tools["read_file"].invoke({"path": "/shared/report.txt"}) == "shared report"


def test_legacy_server_paths_are_not_supported_by_file_tools(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "report.txt").write_text("personal report")

    tools = _tools(personal, shared)

    result = tools["read_file"].invoke({"path": "/app/workspace/users/1/report.txt"})
    assert result.startswith("[Access denied:") or result.startswith("[File not found:")


def test_list_files_maps_shared_absolute_directory(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (shared / "report.txt").write_text("shared report")

    tools = _tools(personal, shared)

    assert "report.txt" in tools["list_files"].invoke({"directory": "/shared"})
