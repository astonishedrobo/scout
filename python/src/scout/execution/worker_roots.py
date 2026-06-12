"""Canonical workspace root derivation for execution-worker RPC."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

_USER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


@dataclass(frozen=True)
class WorkerRootLayout:
    users_parent: Path
    shared_root: Path
    personal_root: Path
    in_sandbox_personal: Path
    in_sandbox_shared: Path


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).resolve()


def worker_layout() -> tuple[Path, Path]:
    """Return (users_parent, shared_root) from worker environment."""
    users_parent = _env_path("SCOUT_WORKSPACE_USERS", "/srv/scout-source/users")
    shared_root = _env_path("SCOUT_WORKSPACE_SHARED", "/srv/scout-source/shared")
    return users_parent, shared_root


def validate_user_id(user_id: str) -> None:
    if not user_id or not _USER_ID_RE.match(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")


def _reject_symlink_escape(path: Path, parent: Path) -> None:
    resolved = path.resolve()
    parent_resolved = parent.resolve()
    try:
        resolved.relative_to(parent_resolved)
    except ValueError as exc:
        raise ValueError(f"Path escapes parent: {path}") from exc
    if path.is_symlink():
        target = path.resolve()
        try:
            target.relative_to(parent_resolved)
        except ValueError as exc:
            raise ValueError(f"Symlink escapes parent: {path} -> {target}") from exc


def derive_user_roots(user_id: str) -> WorkerRootLayout:
    """Derive canonical roots for *user_id*; never trust caller-supplied paths."""
    validate_user_id(user_id)
    users_parent, shared_root = worker_layout()

    if not users_parent.is_dir():
        raise ValueError(f"Users parent missing: {users_parent}")
    if not shared_root.is_dir():
        raise ValueError(f"Shared root missing: {shared_root}")

    personal = (users_parent / user_id).resolve()
    _reject_symlink_escape(personal, users_parent.resolve())

    if not personal.is_dir():
        raise ValueError(f"Personal workspace missing for user {user_id}: {personal}")

    shared = shared_root.resolve()
    _reject_symlink_escape(shared, shared_root.parent.resolve())

    return WorkerRootLayout(
        users_parent=users_parent.resolve(),
        shared_root=shared,
        personal_root=personal,
        in_sandbox_personal=Path(f"/workspace/users/{user_id}"),
        in_sandbox_shared=Path("/workspace/shared"),
    )


def map_roots_for_sandbox(layout: WorkerRootLayout) -> tuple[Path, Path, Path, Path]:
    """Return host paths and their in-sandbox mount targets."""
    return (
        layout.personal_root,
        layout.in_sandbox_personal,
        layout.shared_root,
        layout.in_sandbox_shared,
    )
