"""Workspace artifact classification and safe path helpers."""

from __future__ import annotations

import hashlib
import mimetypes
import re
from pathlib import Path
from typing import Any


# Primary user-facing deliverables (always eligible as UI artifacts).
DELIVERABLE_RENDERERS = {
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
    ".txt": "text",
}

# Code / config: eligible only when not under install/cache trees (see ignore).
CODE_RENDERERS = {
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
}

RENDERERS = {**DELIVERABLE_RENDERERS, **CODE_RENDERERS}

INLINE_RENDERERS = {"image"}
MAX_ARTIFACT_SIZE = 20 * 1024 * 1024

# Never surface as UI artifacts even if the suffix is known.
_ARTIFACT_JUNK_PARTS = frozenset({
    ".scout-cache",
    ".scout-executions",
    ".local",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "site-packages",
})
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


def artifact_path_key(path: str | Path) -> str:
    """Stable identity key for deduping UI cards of the same file."""
    raw = str(path or "").strip().replace("\\", "/")
    if not raw:
        return ""
    while raw.startswith("./"):
        raw = raw[2:]
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/") :]
    elif raw.startswith("workspace/shared/"):
        raw = "shared/" + raw[len("workspace/shared/") :]
    elif raw.startswith("workspace/"):
        raw = raw[len("workspace/") :]
    if raw.startswith("/shared/"):
        raw = "shared/" + raw[len("/shared/") :]
    elif raw == "/shared":
        raw = "shared"
    return raw.lstrip("/")


def describe_artifact(path: Path, root: Path) -> dict[str, Any] | None:
    """Return a client-safe descriptor for a supported user deliverable."""
    path = path.resolve()
    root = root.resolve()
    try:
        rel = path.relative_to(root)
    except ValueError:
        return None
    if not path.is_file() or path.name.startswith("."):
        return None
    if any(part in _ARTIFACT_JUNK_PARTS for part in rel.parts):
        return None
    if any(part.endswith((".dist-info", ".egg-info")) for part in rel.parts):
        return None
    # Install scaffolding is never a deliverable.
    if path.name in {"uv.lock", "package-lock.json", ".python-version"}:
        return None
    renderer = RENDERERS.get(path.suffix.lower())
    if not renderer:
        return None
    size = path.stat().st_size
    if size > MAX_ARTIFACT_SIZE:
        return None
    # Identity is the resolved file path so auto-surfaced edits and
    # present_files for the same deliverable share one card.
    artifact_id = hashlib.sha256(str(path).encode()).hexdigest()[:24]
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


def dedupe_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first card for each path/id; later duplicates are dropped."""
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for artifact in artifacts:
        keys = [
            str(artifact.get("id") or "").strip(),
            artifact_path_key(str(artifact.get("path") or "")),
        ]
        keys = [k for k in keys if k]
        if keys and any(k in seen for k in keys):
            continue
        for key in keys:
            seen.add(key)
        unique.append(artifact)
    return unique
