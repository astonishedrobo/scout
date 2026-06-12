"""Filesystem observation for detecting unattributed tool writes."""

from __future__ import annotations

import difflib
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

MAX_TRACKED_FILE_SIZE = 10_000_000


@dataclass
class FileDiff:
    path: str
    status: str
    diff: str
    old_bytes: bytes | None = None
    new_bytes: bytes | None = None


class FileTracker:
    """Compare a directory before and after a tool call without touching Git."""

    def __init__(self, root: str) -> None:
        self._root = Path(root).resolve()
        self._before: dict[str, bytes] | None = None
        self._cached: list[FileDiff] | None = None

    @property
    def root(self) -> Path:
        return self._root

    def snapshot(self) -> None:
        self._before = self._read_state()
        self._cached = None

    def diff(self, refresh: bool = False) -> list[FileDiff]:
        if self._cached is not None and not refresh:
            return list(self._cached)
        before = self._before or {}
        after = self._read_state()
        changed: list[FileDiff] = []
        for rel in sorted(before.keys() | after.keys()):
            old = before.get(rel)
            new = after.get(rel)
            if old == new:
                continue
            status = "added" if old is None else "deleted" if new is None else "modified"
            changed.append(FileDiff(rel, status, _render_diff(rel, old, new), old, new))
        self._cached = changed
        return list(changed)

    def _read_state(self) -> dict[str, bytes]:
        state: dict[str, bytes] = {}
        for path in self._iter_files():
            try:
                state[str(path.relative_to(self._root))] = path.read_bytes()
            except OSError:
                continue
        return state

    def _iter_files(self) -> list[Path]:
        skip = {".git", ".scout", ".scout-cache", ".scout-executions", "__pycache__", "node_modules", ".venv", "env"}
        files: list[Path] = []
        for dirpath, dirnames, filenames in os.walk(self._root):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for filename in filenames:
                path = Path(dirpath) / filename
                try:
                    if path.stat().st_size <= MAX_TRACKED_FILE_SIZE:
                        files.append(path)
                except OSError:
                    continue
            if len(files) > 5000:
                break
        return files


def exact_file_diff(path: Path, root: Path, old: bytes | None, new: bytes | None) -> FileDiff:
    rel = str(path.resolve().relative_to(root.resolve()))
    status = "added" if old is None else "deleted" if new is None else "modified"
    return FileDiff(rel, status, _render_diff(rel, old, new), old, new)


def content_hash(content: bytes | None) -> str:
    return hashlib.sha256(content or b"").hexdigest()


def _render_diff(path: str, old: bytes | None, new: bytes | None) -> str:
    try:
        old_text = (old or b"").decode("utf-8")
        new_text = (new or b"").decode("utf-8")
    except UnicodeDecodeError:
        return f"Binary file {path} changed ({len(old or b'')} -> {len(new or b'')} bytes)"
    return "".join(difflib.unified_diff(
        old_text.splitlines(keepends=True),
        new_text.splitlines(keepends=True),
        fromfile=path if old is not None else "/dev/null",
        tofile=path if new is not None else "/dev/null",
    ))
