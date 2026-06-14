"""Workspace artifact classification and safe path helpers."""

from __future__ import annotations

import hashlib
import mimetypes
import re
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
_LOCAL_HTML_ASSET = re.compile(
    r"""(?:src|href)\s*=\s*["'](?!data:|https?:|//|#|javascript:)([^"']+)["']|"""
    r"""url\(\s*["']?(?!data:|https?:|//)([^)"']+)""",
    re.IGNORECASE,
)


def local_html_assets(content: str) -> list[str]:
    """Return relative local asset references from HTML/CSS."""
    return [a or b for a, b in _LOCAL_HTML_ASSET.findall(content)]


def html_artifact_warning(path: Path) -> str:
    if path.suffix.lower() not in {".html", ".htm"} or not path.is_file():
        return ""
    refs = local_html_assets(path.read_text(encoding="utf-8", errors="replace"))
    if not refs:
        return ""
    shown = ", ".join(refs[:3])
    return (
        f"[HTML NOT SELF-CONTAINED] Local asset references found: {shown}. "
        "If the user asked to embed assets, inline their bytes as data: URIs; "
        "do not claim referenced files are embedded."
    )


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
