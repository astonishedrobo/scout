"""Lightweight media path helpers shared by the server and agent."""

from __future__ import annotations

from pathlib import Path


IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif"})


def image_paths(paths: list[str] | None) -> list[str]:
    return [
        str(Path(path).resolve())
        for path in (paths or [])
        if Path(path).suffix.casefold() in IMAGE_SUFFIXES
    ]
