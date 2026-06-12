"""Workspace path helpers for multi-user mode.

Defines the directory layout under the workspace root:
  {workspace_root}/users/{user_id}/   — personal sandbox (read/write)
  {workspace_root}/shared/            — team repo (read-only for agents, admin-writable)
"""

from __future__ import annotations

from pathlib import Path


def user_workspace(workspace_root: str | Path, user_id: int | str) -> Path:
    return Path(workspace_root) / "users" / str(user_id)


def shared_workspace(workspace_root: str | Path) -> Path:
    return Path(workspace_root) / "shared"


def ensure_workspaces(workspace_root: str | Path, user_id: int | str) -> tuple[Path, Path]:
    """Create personal and shared dirs if needed. Returns (personal, shared)."""
    personal = user_workspace(workspace_root, user_id)
    shared = shared_workspace(workspace_root)
    personal.mkdir(parents=True, exist_ok=True)
    shared.mkdir(parents=True, exist_ok=True)
    return personal, shared
