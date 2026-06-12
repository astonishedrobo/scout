"""Tests for legacy memories migration."""

from scout.memories import (
    ensure_memory_layout,
    legacy_memories_path,
    load_memory_registry,
    load_memory_summary,
    migrate_legacy_memories,
)


def test_migrate_legacy_bullets(tmp_path):
    legacy = legacy_memories_path(personal_dir=tmp_path, server_mode=True)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("- Prefers dark mode\n- Uses pytest\n", encoding="utf-8")

    assert migrate_legacy_memories(personal_dir=tmp_path, server_mode=True)
    root = ensure_memory_layout(personal_dir=tmp_path, server_mode=True)
    registry = load_memory_registry(personal_dir=tmp_path, server_mode=True)
    summary = load_memory_summary(personal_dir=tmp_path, server_mode=True)
    assert "dark mode" in registry
    assert "pytest" in summary
    assert (root / ".migrated_from_legacy").exists()
