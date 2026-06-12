"""Command-scoped file change detection for staged execution."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from .models import ExecutionFileChange
from .path_utils import is_under_any
from .policy import is_ignored_execution_path


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot_writable_roots(
    write_roots: tuple[Path, ...],
    *,
    workspace_root: Path | None = None,
) -> dict[str, str]:
    """Snapshot relative paths → content hashes inside writable roots."""
    state: dict[str, str] = {}
    for root in write_roots:
        root = root.resolve()
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if d not in {".git", "__pycache__", "node_modules", ".scout-cache", ".scout-executions"}
            ]
            for fname in filenames:
                path = Path(dirpath) / fname
                if workspace_root and is_ignored_execution_path(path, workspace_root):
                    continue
                try:
                    rel = str(path.relative_to(root))
                    key = f"{root}:{rel}"
                    state[key] = _file_hash(path)
                except (OSError, ValueError):
                    continue
    return state


def diff_snapshots(
    before: dict[str, str],
    after: dict[str, str],
    write_roots: tuple[Path, ...],
    *,
    workspace_root: Path | None = None,
) -> list[ExecutionFileChange]:
    """Compare snapshots and return execution-scoped changes."""
    changes: list[ExecutionFileChange] = []
    all_keys = set(before) | set(after)
    for key in sorted(all_keys):
        old_hash = before.get(key)
        new_hash = after.get(key)
        if old_hash == new_hash:
            continue
        root_str, rel = key.split(":", 1)
        root = Path(root_str)
        abs_path = root / rel
        if workspace_root and is_ignored_execution_path(abs_path, workspace_root):
            continue
        if not is_under_any(abs_path, write_roots):
            continue
        status = "added" if old_hash is None else "deleted" if new_hash is None else "modified"
        changes.append(ExecutionFileChange(
            path=str(abs_path),
            status=status,
            old_hash=old_hash,
            new_hash=new_hash,
        ))
    return changes
