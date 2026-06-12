"""Workspace artifact classification and safe path helpers."""

from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path
from typing import Any


RENDERERS = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".svg": "image",
    ".csv": "csv",
    ".json": "json",
    ".py": "code",
    ".js": "code",
    ".jsx": "code",
    ".ts": "code",
    ".tsx": "code",
    ".css": "code",
    ".sql": "code",
    ".yaml": "code",
    ".yml": "code",
    ".toml": "code",
    ".txt": "text",
}

INLINE_RENDERERS = {"image"}
MAX_ARTIFACT_SIZE = 20 * 1024 * 1024


def describe_artifact(path: Path, root: Path) -> dict[str, Any] | None:
    """Return a client-safe descriptor for a supported file."""
    path = path.resolve()
    root = root.resolve()
    try:
        rel = path.relative_to(root)
    except ValueError:
        return None
    if not path.is_file() or path.name.startswith("."):
        return None
    renderer = RENDERERS.get(path.suffix.lower())
    if not renderer:
        return None
    size = path.stat().st_size
    if size > MAX_ARTIFACT_SIZE:
        return None
    artifact_id = hashlib.sha256(f"{root}:{rel}".encode()).hexdigest()[:24]
    return {
        "id": artifact_id,
        "path": str(rel),
        "name": path.name,
        "title": path.stem.replace("_", " ").replace("-", " ").title(),
        "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "renderer": renderer,
        "size": size,
        "version": hashlib.sha256(path.read_bytes()).hexdigest()[:16],
        "presentation": "both" if renderer in INLINE_RENDERERS else "panel",
    }
