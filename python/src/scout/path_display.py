"""User-facing path formatting, agent path resolution, and path redaction."""

from __future__ import annotations

import re
from pathlib import Path


_ABSOLUTE_PATH = re.compile(r"(?<![\w./:-])/(?:[^/\s:'\"`\]\[(),]+/)*[^/\s:'\"`\]\[(),]*")


def resolve_agent_workspace_path(
    path: str | Path,
    personal_root: str | Path,
    shared_root: str | Path | None = None,
) -> Path:
    """Map agent-facing paths onto personal/shared workspace roots.

    Accepts canonical sandbox forms (``/workspace/...``, ``/shared/...``),
    relative ``shared/...``, legacy memory-style ``workspace/shared/...``, and
    bare relative names. When a bare relative path is missing under personal but
    present under shared (common for FTS source basenames), prefer shared.
    """
    personal = Path(personal_root).resolve()
    shared = Path(shared_root).resolve() if shared_root is not None else None
    raw = str(path).strip()
    if not raw:
        return personal
    candidate = Path(raw)

    def under_shared(parts: tuple[str, ...]) -> Path | None:
        if shared is None:
            return None
        return shared / Path(*parts) if parts else shared

    if candidate.is_absolute():
        if candidate.parts[:2] == ("/", "workspace"):
            relative = candidate.parts[2:]
            return personal / Path(*relative) if relative else personal
        if candidate.parts[:2] == ("/", "shared"):
            mapped = under_shared(candidate.parts[2:])
            if mapped is not None:
                return mapped
        return candidate

    parts = candidate.parts
    if parts[:1] == ("shared",):
        mapped = under_shared(parts[1:])
        if mapped is not None:
            return mapped

    # Legacy / memory-style paths written as workspace/shared/...
    if parts[:2] == ("workspace", "shared"):
        mapped = under_shared(parts[2:])
        if mapped is not None:
            return mapped

    personal_candidate = personal / candidate
    if shared is not None and not personal_candidate.exists():
        shared_candidate = shared / candidate
        if shared_candidate.exists():
            return shared_candidate
    return personal_candidate


def display_path(path: str | Path, personal_root: str | Path, shared_root: str | Path | None = None) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        # Prefer resolving known relative aliases so tool results show /shared/...
        try:
            resolved = resolve_agent_workspace_path(candidate, personal_root, shared_root)
            if resolved.exists():
                candidate = resolved
            else:
                return str(candidate)
        except Exception:
            return str(candidate)
    if candidate.parts[:2] in {("/", "workspace"), ("/", "shared")}:
        return str(candidate)
    candidate = candidate.resolve()
    roots = [(Path(personal_root).resolve(), "/workspace")]
    if shared_root is not None:
        roots.append((Path(shared_root).resolve(), "/shared"))
    for root, label in roots:
        try:
            relative = candidate.relative_to(root)
            return label if str(relative) == "." else f"{label}/{relative}"
        except ValueError:
            continue
    return str(candidate)


def redact_paths(text: str, personal_root: str | Path, shared_root: str | Path | None = None) -> str:
    """Replace internal absolute and user-directory paths in model-visible text."""
    return _ABSOLUTE_PATH.sub(
        lambda match: display_path(match.group(0), personal_root, shared_root),
        text,
    )


def _artifact_content_path(
    path: str,
    personal_root: str | Path,
    shared_root: str | Path | None = None,
) -> str:
    """Normalize an artifact path for the content API (relative to a root).

    Host absolute paths are mapped into sandbox form, then stripped to a
    relative path under personal (``plot.png``) or shared (``shared/plot.png``
    is not used — shared files keep a ``shared/`` prefix only when already
    expressed that way; absolute ``/shared/x`` becomes ``x`` with scope left
    to the client). Prefer plain relative paths so ``root / path`` resolves.
    """
    raw = str(path or "").strip().replace("\\", "/")
    if not raw:
        return raw
    # Map host absolute paths into /workspace or /shared first.
    if raw.startswith("/") and not raw.startswith(("/workspace", "/shared")):
        raw = display_path(raw, personal_root, shared_root)
    if raw.startswith("/workspace/"):
        return raw[len("/workspace/") :]
    if raw == "/workspace":
        return "."
    if raw.startswith("/shared/"):
        # Content API tries personal then shared roots with the same relative
        # path, so return the basename path under shared.
        return raw[len("/shared/") :]
    if raw == "/shared":
        return "."
    return raw.lstrip("./")


def sanitize_artifacts(
    artifacts: list[dict],
    personal_root: str | Path,
    shared_root: str | Path | None = None,
) -> list[dict]:
    """Return artifact descriptors with content-safe paths (deduped by path/id)."""
    from .artifacts import dedupe_artifacts

    sanitized = []
    for artifact in artifacts:
        item = dict(artifact)
        item["path"] = _artifact_content_path(
            str(item.get("path", "")), personal_root, shared_root,
        )
        sanitized.append(item)
    return dedupe_artifacts(sanitized)
