"""Workspace locations, browsing, search, and safe path resolution.

The browser-facing API deals exclusively in stable ``scope + relative path``
references. Server filesystem paths never need to be exposed to the client.
"""

from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

from ..artifacts import MAX_ARTIFACT_SIZE, RENDERERS
from ..file_safety import is_name_denied


IGNORED_DIRECTORIES = frozenset({
    ".git",
    ".idea",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".scout",
    ".scout-cache",
    ".scout-executions",
    ".tox",
    ".venv",
    ".vscode",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
})

IGNORED_EXTENSIONS = frozenset({
    ".a",
    ".class",
    ".dll",
    ".dylib",
    ".egg",
    ".jar",
    ".o",
    ".pyc",
    ".pyo",
    ".so",
    ".war",
    ".whl",
})

MAX_DIRECTORY_ENTRIES = 2_000
MAX_SEARCH_SCAN = 30_000


class WorkspacePathError(ValueError):
    """Raised when a client workspace reference is invalid or inaccessible."""


@dataclass(frozen=True, slots=True)
class WorkspaceLocation:
    scope: str
    label: str
    root: Path

    def descriptor(self) -> dict:
        return {
            "name": self.label,
            "path": "",
            "scope": self.scope,
            "type": "dir",
        }


def user_workspace(workspace_root: str | Path, user_id: int | str) -> Path:
    return Path(workspace_root) / "users" / str(user_id)


def shared_workspace(workspace_root: str | Path) -> Path:
    return Path(workspace_root) / "shared"


def ensure_workspaces(workspace_root: str | Path, user_id: int | str) -> tuple[Path, Path]:
    """Create personal and shared workspaces and return both locations."""
    personal = user_workspace(workspace_root, user_id)
    shared = shared_workspace(workspace_root)
    personal.mkdir(parents=True, exist_ok=True)
    shared.mkdir(parents=True, exist_ok=True)
    return personal, shared


def workspace_locations(
    *,
    workspace_root: str | Path,
    cwd: str | Path,
    multi_user: bool,
    user_id: int | str | None,
) -> list[WorkspaceLocation]:
    """Return the roots visible to the current user."""
    if multi_user:
        if user_id is None:
            raise WorkspacePathError("Authentication is required")
        personal, shared = ensure_workspaces(workspace_root, user_id)
        return [
            WorkspaceLocation("personal", "My workspace", personal.resolve()),
            WorkspaceLocation("shared", "Shared", shared.resolve()),
        ]
    return [WorkspaceLocation("workspace", "Workspace", Path(cwd).resolve())]


def location_for_scope(locations: Iterable[WorkspaceLocation], scope: str) -> WorkspaceLocation:
    for location in locations:
        if location.scope == scope:
            return location
    raise WorkspacePathError("Unknown workspace scope")


def _relative_path(value: str, *, allow_empty: bool) -> Path:
    normalized = value.replace("\\", "/").strip("/")
    if not normalized:
        if allow_empty:
            return Path()
        raise WorkspacePathError("A file path is required")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise WorkspacePathError("Invalid workspace path")
    if any(part.startswith(".") for part in pure.parts):
        raise WorkspacePathError("Hidden workspace paths are not available")
    return Path(*pure.parts)


def resolve_workspace_path(
    location: WorkspaceLocation,
    relative_path: str,
    *,
    expect: str = "file",
) -> Path:
    """Resolve a client path beneath a workspace root without following escapes."""
    rel = _relative_path(relative_path, allow_empty=expect == "dir")
    target = (location.root / rel).resolve()
    try:
        target.relative_to(location.root)
    except ValueError as exc:
        raise WorkspacePathError("Workspace path escapes its root") from exc

    if expect == "file" and not target.is_file():
        raise WorkspacePathError("File not found")
    if expect == "dir" and not target.is_dir():
        raise WorkspacePathError("Folder not found")
    return target


def _visible_entry(entry: Path) -> bool:
    if entry.name.startswith(".") or is_name_denied(entry.name):
        return False
    if entry.is_dir():
        return entry.name not in IGNORED_DIRECTORIES
    return entry.is_file() and entry.suffix.lower() not in IGNORED_EXTENSIONS


def _file_descriptor(entry: Path, root: Path) -> dict:
    stat = entry.stat()
    relative = entry.relative_to(root).as_posix()
    renderer = RENDERERS.get(entry.suffix.lower())
    return {
        "name": entry.name,
        "path": relative,
        "type": "file",
        "size": stat.st_size,
        "mime_type": mimetypes.guess_type(entry.name)[0] or "application/octet-stream",
        "renderer": renderer if stat.st_size <= MAX_ARTIFACT_SIZE else None,
        "version": f"{stat.st_mtime_ns:x}-{stat.st_size:x}",
    }


def list_workspace_directory(
    location: WorkspaceLocation,
    relative_path: str = "",
    *,
    limit: int = MAX_DIRECTORY_ENTRIES,
) -> tuple[list[dict], bool]:
    """List one directory level, returning ``(entries, truncated)``."""
    directory = resolve_workspace_path(location, relative_path, expect="dir")
    visible: list[Path] = []
    try:
        for entry in directory.iterdir():
            try:
                if _visible_entry(entry):
                    # Exclude symlinks that resolve outside the visible root.
                    entry.resolve().relative_to(location.root)
                    visible.append(entry)
            except (OSError, ValueError):
                continue
    except OSError as exc:
        raise WorkspacePathError("Folder could not be read") from exc

    visible.sort(key=lambda entry: (not entry.is_dir(), entry.name.casefold()))
    truncated = len(visible) > limit
    nodes: list[dict] = []
    for entry in visible[:limit]:
        if entry.is_dir():
            nodes.append({
                "name": entry.name,
                "path": entry.relative_to(location.root).as_posix(),
                "type": "dir",
            })
            continue
        try:
            nodes.append(_file_descriptor(entry, location.root))
        except OSError:
            continue
    return nodes, truncated


def _fuzzy_score(candidate: str, query: str) -> int | None:
    q = query.casefold().strip()
    text = candidate.casefold()
    name = PurePosixPath(candidate).name.casefold()
    if not q:
        return 0
    if name.startswith(q):
        return 400 - min(len(name), 200)
    if text.startswith(q):
        return 350 - min(len(text), 200)
    if f"/{q}" in text:
        return 300 - min(len(text), 200)
    if q in name:
        return 260 - min(len(name), 200)
    if q in text:
        return 220 - min(len(text), 200)

    cursor = -1
    score = 120
    for character in q:
        next_cursor = text.find(character, cursor + 1)
        if next_cursor < 0:
            return None
        gap = next_cursor - cursor - 1
        score += 6 if gap == 0 else 3 if gap <= 2 else 1
        cursor = next_cursor
    return score - min(len(text), 120) // 4


def search_workspace_files(
    locations: Iterable[WorkspaceLocation],
    query: str,
    *,
    limit: int = 80,
) -> list[dict]:
    """Search visible workspace files with a bounded filesystem walk."""
    query = query.strip()
    matches: list[tuple[int, str, str, dict]] = []
    scanned = 0
    for location in locations:
        for root_string, directories, files in os.walk(location.root):
            directories[:] = sorted(
                directory
                for directory in directories
                if not directory.startswith(".")
                and directory not in IGNORED_DIRECTORIES
                and not is_name_denied(directory)
            )
            root = Path(root_string)
            for filename in files:
                if scanned >= MAX_SEARCH_SCAN:
                    break
                scanned += 1
                entry = root / filename
                if not _visible_entry(entry):
                    continue
                try:
                    entry.resolve().relative_to(location.root)
                    relative = entry.relative_to(location.root).as_posix()
                    score = _fuzzy_score(relative, query)
                    if score is None:
                        continue
                    descriptor = _file_descriptor(entry, location.root)
                except (OSError, ValueError):
                    continue
                descriptor["scope"] = location.scope
                matches.append((score, relative, location.scope, descriptor))
            if scanned >= MAX_SEARCH_SCAN:
                break
        if scanned >= MAX_SEARCH_SCAN:
            break

    matches.sort(key=lambda item: (-item[0], item[1].casefold(), item[2]))
    return [item[3] for item in matches[:limit]]
