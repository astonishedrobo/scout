"""Memory citation parse/strip used by the response harness."""

from scout.memories_citations import parse_memory_citation, strip_citation_block


SAMPLE = """I can't find the actual PDF file in the workspace.

Options — pick one:
- Upload the PDF here

Which do you prefer?

<scout-mem-citation>
<citation_entries>
MEMORY.md:3|note=[used to check expected PDF path]
</citation_entries>
<rollout_ids>
session-uuid-here
</rollout_ids>
</scout-mem-citation>
"""


def test_strip_citation_block_removes_harness_markup():
    cleaned = strip_citation_block(SAMPLE)
    assert "scout-mem-citation" not in cleaned
    assert "citation_entries" not in cleaned
    assert "Which do you prefer?" in cleaned
    assert cleaned.endswith("Which do you prefer?")


def test_parse_memory_citation_reads_entries_without_valid_uuid():
    citation = parse_memory_citation(SAMPLE)
    assert citation is not None
    assert citation.entries
    path, start, end, note = citation.entries[0]
    assert path == "MEMORY.md"
    assert start == 3
    assert end is None
    assert "expected PDF path" in note
    # Placeholder text is not a UUID, so rollout_ids stays empty.
    assert citation.rollout_ids == []


def test_strip_is_noop_without_block():
    text = "Assam is most vulnerable."
    assert strip_citation_block(text) == text


def test_strip_partial_citation_entries_fragment():
    """Regression: models sometimes emit only inner tags (no scout-mem-citation)."""
    text = (
        "I saved it as an image: /workspace/most_vulnerable_page.png.\n\n"
        "<citation_entries> MEMORY.md:10-12|note=[how used] </citation_entries>"
    )
    cleaned = strip_citation_block(text)
    assert "citation_entries" not in cleaned
    assert "MEMORY.md" not in cleaned
    assert "most_vulnerable_page.png" in cleaned


def test_parse_partial_citation_entries():
    text = "<citation_entries>\nMEMORY.md:10-12|note=[how used]\n</citation_entries>"
    citation = parse_memory_citation(text)
    assert citation is not None
    assert citation.entries[0][0] == "MEMORY.md"
