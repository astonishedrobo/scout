"""Tests for memory backend path jail."""

from scout.memories_backend import MemoriesBackend


def test_memory_search_and_jail(tmp_path):
    backend = MemoriesBackend(personal_dir=tmp_path, server_mode=True, user_id="u1")
    root = backend.root
    (root / "MEMORY.md").write_text("- user prefers tabs\n", encoding="utf-8")
    hits = backend.search("tabs")
    assert "MEMORY.md" in hits
    assert "[Invalid memory path" in backend.read("../escape.md")
    assert backend.add_ad_hoc_note("test-note", "hello").startswith(
        "Wrote memory note to MEMORY.md"
    )
    assert "- hello" in (root / "MEMORY.md").read_text(encoding="utf-8")
