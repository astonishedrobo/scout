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


def test_read_file_maps_server_absolute_personal_path(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "report.txt").write_text("personal report")

    tools = _tools(personal, shared)

    result = tools["read_file"].invoke(
        {"path": "/app/workspace/users/1/report.txt"}
    )
    assert result == "personal report"


def test_read_file_maps_server_absolute_shared_path(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (shared / "report.txt").write_text("shared report")

    tools = _tools(personal, shared)

    result = tools["read_file"].invoke(
        {"path": "/app/workspace/shared/report.txt"}
    )
    assert result == "shared report"


def test_read_file_maps_relative_user_and_display_paths(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "report.txt").write_text("personal report")

    tools = _tools(personal, shared)

    for path in ("users/1/report.txt", "workspace/report.txt"):
        assert tools["read_file"].invoke({"path": path}) == "personal report"


def test_read_file_maps_relative_shared_path(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (shared / "report.txt").write_text("shared report")

    tools = _tools(personal, shared)

    assert tools["read_file"].invoke({"path": "shared/report.txt"}) == "shared report"
