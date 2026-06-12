"""Boundary-safe path membership checks."""

from __future__ import annotations

from pathlib import Path


def is_under_root(path: Path | str, root: Path | str) -> bool:
    """Return True if *path* is *root* or a descendant of *root*."""
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def is_under_any(path: Path | str, roots: tuple[Path, ...] | list[Path]) -> bool:
    return any(is_under_root(path, root) for root in roots)
