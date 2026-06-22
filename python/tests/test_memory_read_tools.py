"""Tests for memory backend path jail."""

from scout.memories_backend import MemoriesBackend


def test_memory_search_and_jail(tmp_path):
    backend = MemoriesBackend(personal_dir=tmp_path, server_mode=True, user_id="u1")
    root = backend.root
    (root / "MEMORY.md").write_text("- user prefers tabs\n", encoding="utf-8")
    hits = backend.search("tabs")
    assert "MEMORY.md" in hits
    assert "user prefers tabs" in backend.search("fruit")
    assert "[Invalid memory path" in backend.read("../escape.md")
    assert "[Invalid memory path" in backend.read("raw_memories.md")
    assert backend.add_memory("test-note", "hello") == "Wrote memory to MEMORY.md"
    assert "- hello" in (root / "MEMORY.md").read_text(encoding="utf-8")
