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


def test_read_file_supports_bounded_line_paging(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "long.txt").write_text(
        "\n".join(f"line-{i}" for i in range(1, 11)), encoding="utf-8"
    )
    tools = _tools(personal, shared)

    result = tools["read_file"].invoke({"path": "long.txt", "offset": 4, "max_lines": 3})

    assert result.startswith("line-4\nline-5\nline-6")
    assert "use offset=7 to continue" in result


def test_read_file_rejects_non_positive_offset(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (personal / "report.txt").write_text("content", encoding="utf-8")
    tools = _tools(personal, shared)

    assert "Invalid offset" in tools["read_file"].invoke({"path": "report.txt", "offset": 0})


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


def test_list_files_supports_bounded_paging(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    for name in ("a.txt", "b.txt", "c.txt", "d.txt"):
        (personal / name).write_text(name, encoding="utf-8")
    tools = _tools(personal, shared)

    first = tools["list_files"].invoke({"max_entries": 2})
    second = tools["list_files"].invoke({"offset": 3, "max_entries": 2})

    assert "a.txt" in first and "b.txt" in first and "offset=3" in first
    assert "c.txt" in second and "d.txt" in second and "more entries" not in second
