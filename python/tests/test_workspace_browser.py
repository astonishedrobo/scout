from pathlib import Path

import pytest

from scout.server.workspace import (
    WorkspaceLocation,
    WorkspacePathError,
    list_workspace_directory,
    resolve_workspace_path,
    search_workspace_files,
)


def location(root: Path) -> WorkspaceLocation:
    return WorkspaceLocation("workspace", "Workspace", root.resolve())


def test_directory_listing_is_lazy_and_includes_preview_metadata(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "nested.py").write_text("print('nested')")
    (tmp_path / "README.md").write_text("# Scout")

    entries, truncated = list_workspace_directory(location(tmp_path))

    assert truncated is False
    assert [entry["name"] for entry in entries] == ["src", "README.md"]
    assert "children" not in entries[0]
    assert entries[1]["renderer"] == "markdown"
    assert entries[1]["size"] == len("# Scout")
    assert entries[1]["version"]


def test_workspace_paths_cannot_escape_or_access_hidden_files(tmp_path: Path):
    (tmp_path / "visible.txt").write_text("ok")
    (tmp_path / ".private.txt").write_text("no")

    assert resolve_workspace_path(location(tmp_path), "visible.txt") == tmp_path / "visible.txt"
    with pytest.raises(WorkspacePathError):
        resolve_workspace_path(location(tmp_path), "../outside.txt")
    with pytest.raises(WorkspacePathError):
        resolve_workspace_path(location(tmp_path), ".private.txt")


def test_workspace_search_returns_scoped_ranked_results(tmp_path: Path):
    (tmp_path / "reports").mkdir()
    (tmp_path / "reports" / "quarterly-summary.md").write_text("summary")
    (tmp_path / "summary-notes.txt").write_text("notes")

    results = search_workspace_files([location(tmp_path)], "summary")

    assert [result["path"] for result in results] == [
        "summary-notes.txt",
        "reports/quarterly-summary.md",
    ]
    assert all(result["scope"] == "workspace" for result in results)
