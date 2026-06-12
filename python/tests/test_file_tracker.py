from pathlib import Path

from scout.agent.file_tracker import FileTracker, content_hash, exact_file_diff


def test_tracker_only_reports_changes_after_snapshot(tmp_path: Path):
    existing = tmp_path / "existing.txt"
    existing.write_text("user change")
    tracker = FileTracker(str(tmp_path))
    tracker.snapshot()

    created = tmp_path / "agent.txt"
    created.write_text("agent change")

    diffs = tracker.diff()
    assert [(d.path, d.status) for d in diffs] == [("agent.txt", "added")]
    assert existing.read_text() == "user change"


def test_tracker_is_binary_safe_and_cached(tmp_path: Path):
    image = tmp_path / "plot.png"
    tracker = FileTracker(str(tmp_path))
    tracker.snapshot()
    image.write_bytes(b"\x89PNG\x00\xff")

    first = tracker.diff()
    image.write_bytes(b"changed later")
    second = tracker.diff()

    assert first == second
    assert "Binary file plot.png changed" in first[0].diff


def test_exact_mutation_preserves_preexisting_content(tmp_path: Path):
    target = tmp_path / "report.md"
    target.write_text("user baseline")
    old = target.read_bytes()
    diff = exact_file_diff(target, tmp_path, old, b"agent proposal")

    assert diff.status == "modified"
    assert "-user baseline" in diff.diff
    assert "+agent proposal" in diff.diff
    assert content_hash(target.read_bytes()) == content_hash(old)


def test_conflict_hash_changes_when_other_thread_writes(tmp_path: Path):
    target = tmp_path / "shared.txt"
    target.write_text("before")
    baseline = content_hash(target.read_bytes())
    target.write_text("other thread")

    assert content_hash(target.read_bytes()) != baseline
