"""Track filesystem changes around tool execution using git or file hashing.

Provides snapshot/diff/revert semantics:
- ``snapshot()`` records the state of files before a tool runs
- ``diff()`` computes what changed after the tool ran
- ``revert()`` undoes the changes (git checkout or file restore)
- ``open_editor()`` launches $EDITOR on changed files
"""

from __future__ import annotations

import difflib
import hashlib
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class FileDiff:
    """A single file change detected after tool execution."""

    path: str
    status: str  # "added", "modified", "deleted"
    diff: str  # unified diff text
    old_content: str = ""
    new_content: str = ""


class FileTracker:
    """Detect filesystem changes between snapshot() and diff() calls.

    Uses git if the working directory is inside a git repo; otherwise
    falls back to file-content hashing scoped to *root*.
    """

    def __init__(self, root: str) -> None:
        self._root = Path(root).resolve()
        self._use_git = self._has_git()
        self._pre_status: dict[str, str] | None = None  # path -> hash
        self._pre_contents: dict[str, str] = {}  # path -> content (for revert)
        self._new_files: list[str] = []  # files that didn't exist before

    def _has_git(self) -> bool:
        try:
            r = subprocess.run(
                ["git", "rev-parse", "--is-inside-work-tree"],
                cwd=self._root, capture_output=True, text=True, timeout=5,
            )
            return r.returncode == 0
        except Exception:
            return False

    def _git_root(self) -> str:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=self._root, capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()

    # ── Snapshot ──────────────────────────────────────────────────────

    def snapshot(self) -> None:
        """Capture the pre-execution state of files."""
        if self._use_git:
            self._snapshot_git()
        else:
            self._snapshot_hash()

    def _snapshot_git(self) -> None:
        subprocess.run(
            ["git", "add", "-A"],
            cwd=self._root, capture_output=True, timeout=10,
        )
        r = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self._root, capture_output=True, text=True, timeout=10,
        )
        self._pre_status = {}
        for line in r.stdout.strip().splitlines():
            if len(line) > 3:
                self._pre_status[line[3:].strip()] = line[:2].strip()

    def _snapshot_hash(self) -> None:
        self._pre_status = {}
        self._pre_contents = {}
        for p in self._iter_files():
            rel = str(p.relative_to(self._root))
            self._pre_status[rel] = self._hash_file(p)
            try:
                self._pre_contents[rel] = p.read_text(errors="replace")
            except Exception:
                self._pre_contents[rel] = ""

    # ── Diff ─────────────────────────────────────────────────────────

    def diff(self) -> list[FileDiff]:
        """Compute file changes since the last snapshot()."""
        if self._use_git:
            return self._diff_git()
        return self._diff_hash()

    def _diff_git(self) -> list[FileDiff]:
        subprocess.run(
            ["git", "add", "-A"],
            cwd=self._root, capture_output=True, timeout=10,
        )
        r = subprocess.run(
            ["git", "diff", "--cached", "--no-color"],
            cwd=self._root, capture_output=True, text=True, timeout=10,
        )
        if not r.stdout.strip():
            return []

        diffs: list[FileDiff] = []
        current_path = ""
        current_lines: list[str] = []
        status = "modified"

        def _flush():
            if current_path and current_lines:
                diffs.append(FileDiff(
                    path=current_path,
                    status=status,
                    diff="\n".join(current_lines),
                ))

        for line in r.stdout.splitlines():
            if line.startswith("diff --git"):
                _flush()
                current_lines = [line]
                parts = line.split(" b/", 1)
                current_path = parts[1] if len(parts) > 1 else ""
                status = "modified"
            elif line.startswith("new file"):
                status = "added"
                current_lines.append(line)
            elif line.startswith("deleted file"):
                status = "deleted"
                current_lines.append(line)
            else:
                current_lines.append(line)

        _flush()

        # Reset the staging area so git stays clean
        subprocess.run(
            ["git", "reset", "HEAD"],
            cwd=self._root, capture_output=True, timeout=10,
        )

        # Store info for revert
        self._new_files = [d.path for d in diffs if d.status == "added"]
        for d in diffs:
            if d.status == "modified":
                fp = self._root / d.path
                if fp.exists():
                    pass  # git checkout will handle it

        return diffs

    def _diff_hash(self) -> list[FileDiff]:
        if self._pre_status is None:
            return []

        post_status: dict[str, str] = {}
        post_contents: dict[str, str] = {}
        for p in self._iter_files():
            rel = str(p.relative_to(self._root))
            post_status[rel] = self._hash_file(p)
            try:
                post_contents[rel] = p.read_text(errors="replace")
            except Exception:
                post_contents[rel] = ""

        diffs: list[FileDiff] = []

        # New or modified files
        for rel, h in post_status.items():
            pre_h = self._pre_status.get(rel)
            if pre_h is None:
                new_content = post_contents.get(rel, "")
                diff_text = "".join(difflib.unified_diff(
                    [], new_content.splitlines(keepends=True),
                    fromfile="/dev/null", tofile=rel,
                ))
                diffs.append(FileDiff(
                    path=rel, status="added", diff=diff_text,
                    new_content=new_content,
                ))
                self._new_files.append(rel)
            elif h != pre_h:
                old_content = self._pre_contents.get(rel, "")
                new_content = post_contents.get(rel, "")
                diff_text = "".join(difflib.unified_diff(
                    old_content.splitlines(keepends=True),
                    new_content.splitlines(keepends=True),
                    fromfile=f"a/{rel}", tofile=f"b/{rel}",
                ))
                diffs.append(FileDiff(
                    path=rel, status="modified", diff=diff_text,
                    old_content=old_content, new_content=new_content,
                ))

        # Deleted files
        for rel in self._pre_status:
            if rel not in post_status:
                old_content = self._pre_contents.get(rel, "")
                diff_text = "".join(difflib.unified_diff(
                    old_content.splitlines(keepends=True), [],
                    fromfile=rel, tofile="/dev/null",
                ))
                diffs.append(FileDiff(
                    path=rel, status="deleted", diff=diff_text,
                    old_content=old_content,
                ))

        return diffs

    # ── Revert ───────────────────────────────────────────────────────

    def revert(self) -> None:
        """Undo all changes detected by the last diff()."""
        if self._use_git:
            self._revert_git()
        else:
            self._revert_hash()

    def _revert_git(self) -> None:
        # Remove newly created files
        for f in self._new_files:
            fp = self._root / f
            if fp.exists():
                fp.unlink()

        # Restore modified/deleted files
        subprocess.run(
            ["git", "checkout", "--", "."],
            cwd=self._root, capture_output=True, timeout=10,
        )
        # Clean untracked files that git checkout doesn't handle
        subprocess.run(
            ["git", "clean", "-fd"],
            cwd=self._root, capture_output=True, timeout=10,
        )

    def _revert_hash(self) -> None:
        # Remove new files
        for rel in self._new_files:
            fp = self._root / rel
            if fp.exists():
                fp.unlink()

        # Restore modified files from saved content
        for rel, content in self._pre_contents.items():
            fp = self._root / rel
            if fp.exists():
                current = fp.read_text(errors="replace")
                if current != content:
                    fp.write_text(content, encoding="utf-8")

    # ── External editor ──────────────────────────────────────────────

    def open_editor(self, diffs: list[FileDiff]) -> list[FileDiff]:
        """Open changed files in the user's editor, then return updated diffs."""
        editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "vi"
        paths = [str(self._root / d.path) for d in diffs if d.status != "deleted"]

        if not paths:
            return diffs

        try:
            if "code" in editor.lower():
                for p in paths:
                    subprocess.run([editor, "--wait", p], timeout=300)
            else:
                subprocess.run([editor] + paths, timeout=300)
        except Exception as exc:
            logger.warning("Editor launch failed: %s", exc)

        return self.diff()

    # ── Helpers ───────────────────────────────────────────────────────

    def _iter_files(self) -> list[Path]:
        """Walk root and return all regular files (skip hidden dirs, big dirs)."""
        skip = {".git", ".scout", "__pycache__", "node_modules", ".venv", "env"}
        files: list[Path] = []
        for dirpath, dirnames, filenames in os.walk(self._root):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for fname in filenames:
                fp = Path(dirpath) / fname
                try:
                    if fp.stat().st_size > 10_000_000:
                        continue
                except OSError:
                    continue
                files.append(fp)
            if len(files) > 5000:
                break
        return files

    @staticmethod
    def _hash_file(path: Path) -> str:
        try:
            return hashlib.md5(path.read_bytes()).hexdigest()
        except Exception:
            return ""
