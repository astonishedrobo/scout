from pathlib import Path

from scout.agent.file_tracker import exact_file_diff
from scout.agent.graph import _file_change_sets


def test_file_change_set_contains_reversible_content_and_hashes(tmp_path: Path):
    target = tmp_path / "note.txt"
    old = b"old\n"
    new = b"new\n"
    target.write_bytes(old)
    diff = exact_file_diff(target, tmp_path, old, new)

    sets = _file_change_sets("write_file", [diff])

    assert len(sets) == 1
    entry = sets[0]["entries"][0]
    assert entry["path"] == "note.txt"
    assert entry["status"] == "modified"
    assert entry["old_hash"]
    assert entry["new_hash"]
    assert entry["old_content_base64"]
    assert entry["new_content_base64"]
    assert entry["reversible"] is True
