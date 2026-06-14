"""User-facing path formatting and model-visible path redaction."""

from __future__ import annotations

import re
from pathlib import Path


_ABSOLUTE_PATH = re.compile(r"(?<![\w./:-])/(?:[^/\s:'\"`\]\[(),]+/)*[^/\s:'\"`\]\[(),]*")
_USER_RELATIVE_PATH = re.compile(r"(?<![\w./-])users/[^/\s:'\"`\]\[(),]+/")


def display_path(path: str | Path, personal_root: str | Path, shared_root: str | Path | None = None) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        return str(candidate)
    candidate = candidate.resolve()
    roots = [(Path(personal_root).resolve(), "workspace")]
    if shared_root is not None:
        roots.append((Path(shared_root).resolve(), "shared"))
    for root, label in roots:
        try:
            relative = candidate.relative_to(root)
            return label if str(relative) == "." else f"{label}/{relative}"
        except ValueError:
            continue
    return "[internal path]"


def redact_paths(text: str, personal_root: str | Path, shared_root: str | Path | None = None) -> str:
    """Replace internal absolute and user-directory paths in model-visible text."""
    text = _USER_RELATIVE_PATH.sub("workspace/", text)
    return _ABSOLUTE_PATH.sub(
        lambda match: display_path(match.group(0), personal_root, shared_root),
        text,
    )


def sanitize_artifacts(
    artifacts: list[dict],
    personal_root: str | Path,
    shared_root: str | Path | None = None,
) -> list[dict]:
    """Return artifact descriptors with model/UI-safe display paths."""
    sanitized = []
    for artifact in artifacts:
        item = dict(artifact)
        path = redact_paths(str(item.get("path", "")), personal_root, shared_root)
        if path.startswith("workspace/"):
            path = path.removeprefix("workspace/")
        item["path"] = path
        sanitized.append(item)
    return sanitized
