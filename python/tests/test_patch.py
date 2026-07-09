"""Tests for apply_patch parser."""

from pathlib import Path

from scout.agent.patch import parse_patch, parse_unified_patch


def test_parse_single_file_patch(tmp_path: Path):
    f = tmp_path / "hello.txt"
    f.write_text("line1\nline2\n", encoding="utf-8")
    patch = """--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,2 @@
 line1
-line2
+line2 modified
"""
    results = parse_unified_patch(patch, tmp_path)
    assert len(results) == 1
    assert b"line2 modified" in results[0].new_content


def test_parse_codex_freeform_patch(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("line1\nline2\n", encoding="utf-8")
    patch = """*** Begin Patch
*** Update File: hello.txt
@@
 line1
-line2
+line2 modified
*** End Patch
"""
    results = parse_patch(patch, tmp_path)
    assert len(results) == 1
    assert b"line2 modified" in results[0].new_content
    assert results[0].delete is False


def test_parse_codex_delete_patch_is_explicit(tmp_path):
    f = tmp_path / "delete_me.txt"
    f.write_text("remove\n", encoding="utf-8")
    patch = """*** Begin Patch
*** Delete File: delete_me.txt
*** End Patch
"""
    results = parse_patch(patch, tmp_path)
    assert len(results) == 1
    assert results[0].delete is True


def test_parse_empty_file_patch_is_not_delete(tmp_path):
    patch = """*** Begin Patch
*** Add File: empty.txt
*** End Patch
"""
    results = parse_patch(patch, tmp_path)
    assert len(results) == 1
    assert results[0].new_content == b""
    assert results[0].delete is False
