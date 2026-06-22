"""Codex-style memory folder layout, migration, and read helpers."""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_XDG_CONFIG = Path.home() / ".config" / "scout"
_MAX_MEMORY_CHARS = 16_000  # ~4000 tokens rough


def memories_root(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> Path:
    if server_mode and personal_dir:
        return Path(personal_dir) / ".scout" / "memories"
    return _XDG_CONFIG / "memories"


def legacy_memories_path(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> Path:
    if server_mode and personal_dir:
        return Path(personal_dir) / ".scout" / "memories.md"
    return _XDG_CONFIG / "memories.md"


def _ensure_dirs(root: Path) -> None:
    (root / "rollout_summaries").mkdir(parents=True, exist_ok=True)
    (root / "skills").mkdir(parents=True, exist_ok=True)
    for name, default in (
        ("MEMORY.md", "# Memory registry\n\n"),
        ("raw_memories.md", ""),
    ):
        p = root / name
        if not p.exists():
            p.write_text(default, encoding="utf-8")


def ensure_memory_layout(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> Path:
    root = memories_root(user_id, personal_dir, server_mode)
    _ensure_dirs(root)
    migrate_legacy_memories(user_id, personal_dir, server_mode)
    return root


def migrate_legacy_memories(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> bool:
    legacy = legacy_memories_path(user_id, personal_dir, server_mode)
    if not legacy.exists():
        return False
    root = memories_root(user_id, personal_dir, server_mode)
    _ensure_dirs(root)
    marker = root / ".migrated_from_legacy"
    if marker.exists():
        return False
    try:
        content = legacy.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not content:
        marker.write_text(str(int(time.time())), encoding="utf-8")
        return False

    memory_md = root / "MEMORY.md"
    entries = re.split(r"\n(?=- )", content)
    registry_lines = ["# Memory registry", "", "_Migrated from legacy memories.md_", ""]
    for entry in entries:
        e = entry.strip()
        if e:
            registry_lines.append(e if e.startswith("- ") else f"- {e}")
    memory_md.write_text("\n".join(registry_lines) + "\n", encoding="utf-8")

    marker.write_text(str(int(time.time())), encoding="utf-8")
    logger.info("Migrated legacy memories from %s", legacy)
    return True


def load_memory_summary(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
    *,
    max_chars: int = _MAX_MEMORY_CHARS,
) -> str:
    content = load_memory_registry(user_id, personal_dir, server_mode).strip()
    if len(content) > max_chars:
        content = content[: max_chars // 2] + "\n… [truncated] …\n" + content[-max_chars // 4 :]
    return content


def load_memory_registry(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    root = ensure_memory_layout(user_id, personal_dir, server_mode)
    path = root / "MEMORY.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def save_memory_registry(
    content: str,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> None:
    root = ensure_memory_layout(user_id, personal_dir, server_mode)
    content = content.strip() + "\n"
    (root / "MEMORY.md").write_text(content, encoding="utf-8")


def save_memory_summary(
    content: str,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> None:
    # Compatibility no-op: MEMORY.md is the only memory source of truth.
    _ = (content, user_id, personal_dir, server_mode)


def _entries_from_registry_text(text: str) -> list[str]:
    entries = re.split(r"\n(?=- )", text)
    cleaned: list[str] = []
    for entry in entries:
        value = entry.strip()
        if not value or value.startswith("#") or value.startswith("_"):
            continue
        if value.startswith("- "):
            cleaned.append(value)
    return cleaned


def refresh_memory_summary(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    # Compatibility alias for older callers.
    return load_memory_registry(user_id, personal_dir, server_mode)


def list_memory_entries(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> list[str]:
    text = load_memory_registry(user_id, personal_dir, server_mode)
    if not text:
        return []
    return _entries_from_registry_text(text)


def add_memory_entry(
    entry: str,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    entry = entry.strip()
    if not entry:
        return load_memory_registry(user_id, personal_dir, server_mode)
    if not entry.startswith("- "):
        entry = f"- {entry}"
    existing = load_memory_registry(user_id, personal_dir, server_mode)
    combined = f"{existing.rstrip()}\n{entry}\n"
    save_memory_registry(combined, user_id, personal_dir, server_mode)
    return combined


def remove_memory_entry(
    index: int,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    entries = list_memory_entries(user_id, personal_dir, server_mode)
    if index < 0 or index >= len(entries):
        return load_memory_registry(user_id, personal_dir, server_mode)
    entries.pop(index)
    header = "# Memory registry\n\n"
    body = "\n".join(entries) if entries else "_No entries._"
    combined = header + body + "\n"
    save_memory_registry(combined, user_id, personal_dir, server_mode)
    return combined


def resolve_memory_path(root: Path, relative: str) -> Path | None:
    """Resolve path under memories root; return None if escapes jail."""
    rel = relative.strip().lstrip("/")
    if ".." in Path(rel).parts:
        return None
    target = (root / rel).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None
    return target


# Deprecated aliases — MEMORY.md is the only source of truth.
def load_memories(
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    return load_memory_registry(user_id, personal_dir, server_mode)


def save_memories(
    content: str,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> None:
    save_memory_registry(content, user_id, personal_dir, server_mode)


def add_memory(
    entry: str,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    return add_memory_entry(entry, user_id, personal_dir, server_mode)


def remove_memory(
    index: int,
    user_id: str | int = "default",
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str:
    return remove_memory_entry(index, user_id, personal_dir, server_mode)
