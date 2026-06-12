"""Tests for hierarchical AGENTS.md-style instructions."""

from pathlib import Path

from scout.skills import load_layered_instructions


def test_layered_instructions_root_and_subtree(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("Root: use pandas", encoding="utf-8")
    finance = tmp_path / "finance"
    finance.mkdir()
    (finance / "AGENTS.md").write_text("Finance: use decimal types", encoding="utf-8")

    text = load_layered_instructions(tmp_path, focus_path=finance)
    assert "Root: use pandas" in text
    assert "Finance: use decimal types" in text
    assert text.index("Root") < text.index("Finance")
