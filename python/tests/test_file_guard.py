"""Tests for boundary-safe WorkspaceGuard path checks."""

from pathlib import Path

import pytest

from scout.agent.file_guard import WorkspaceGuard
from scout.execution.path_utils import is_under_root


def test_is_under_root_rejects_sibling_prefix(tmp_path: Path):
    users = tmp_path / "users"
    user1 = users / "1"
    user12 = users / "12"
    user1.mkdir(parents=True)
    user12.mkdir()

    assert is_under_root(user1 / "file.txt", user1)
    assert not is_under_root(user12 / "file.txt", user1)


def test_workspace_guard_rejects_other_user_workspace(tmp_path: Path):
    users = tmp_path / "users"
    personal = users / "1"
    other = users / "12"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    other.mkdir()
    shared.mkdir()
    (other / "secret.txt").write_text("secret")
    (shared / "ok.txt").write_text("shared")

    guard = WorkspaceGuard(personal, shared)
    assert guard.is_read_denied(other / "secret.txt")
    assert not guard.is_read_denied(shared / "ok.txt")
    assert not guard.is_read_denied(personal / "mine.txt")


def test_workspace_guard_write_only_personal(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()

    guard = WorkspaceGuard(personal, shared, allow_write_shared=False)
    assert not guard.is_write_denied(personal / "out.txt")
    assert guard.is_write_denied(shared / "out.txt")


def test_workspace_guard_admin_shared_write(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()

    guard = WorkspaceGuard(personal, shared, allow_write_shared=True)
    assert not guard.is_write_denied(shared / "out.txt")


def test_symlink_escape_denied(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    outside = tmp_path / "outside"
    personal.mkdir(parents=True)
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")

    link = personal / "escape"
    link.symlink_to(outside / "secret.txt")

    guard = WorkspaceGuard(personal, tmp_path / "shared")
    # Resolved path is outside personal — should be denied
    assert guard.is_read_denied(link)
