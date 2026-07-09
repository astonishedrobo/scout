"""Application-level file access guard.

Blocks reading sensitive files regardless of whether the OS-level sandbox
is active.  This is defense-in-depth: even if the sandbox fails to
initialize (e.g. missing socat/bwrap), these rules still apply.

The guard is enforced at the tool layer -- every tool that touches
the filesystem (read_file, list_files, read_pdf, run_code) checks
paths through this module before proceeding.

In multi-user mode, a WorkspaceGuard instance is injected into each
session's tools, replacing the module-level is_path_denied() calls with
user-aware read/write checks.
"""

from __future__ import annotations

import ast
import fnmatch
import os
import re
from pathlib import Path

from ..execution.path_utils import is_under_root
from ..execution.policy import is_deny_read_path
from ..file_safety import (
    DENIED_BASENAMES,
    DENIED_DIRECTORIES,
    DENIED_GLOBS,
    is_name_denied,
)

# ── Sensitive filename patterns ──────────────────────────────────────────

_HOME = Path.home()
DENIED_ABSOLUTE_PREFIXES = [
    str(_HOME / ".ssh"),
    str(_HOME / ".gnupg"),
    str(_HOME / ".aws"),
    str(_HOME / ".config" / "scout"),
    "/app",
]


def is_path_denied(filepath: str | Path) -> bool:
    """Return True if the given path should be blocked from reading."""
    p = Path(filepath).resolve()
    abs_str = str(p)

    name = p.name.lower()

    # Exact basename match
    if name in DENIED_BASENAMES:
        return True

    # Glob pattern match on basename
    for pattern in DENIED_GLOBS:
        if fnmatch.fnmatch(name, pattern):
            return True

    # Any ancestor directory is in the denied set
    for part in p.parts:
        if part.lower() in DENIED_DIRECTORIES:
            return True

    # Absolute prefix match (home dir secrets)
    for prefix in DENIED_ABSOLUTE_PREFIXES:
        if abs_str.startswith(prefix):
            return True

    return False


# ── Per-user workspace guard (multi-user mode) ───────────────────────────

class WorkspaceGuard:
    """Stateful, user-aware file access guard for multi-user mode.

    Injected into each session's tools at session creation time.
    Replaces the module-level is_path_denied() calls with checks that
    are scoped to the user's personal workspace and the shared repo.

    Read  : allowed in personal_dir OR shared_dir, denied elsewhere.
    Write : allowed only in personal_dir (or shared_dir when admin).
    """

    def __init__(
        self,
        personal_dir: Path,
        shared_dir: Path,
        allow_write_shared: bool = False,
    ) -> None:
        self._personal = personal_dir.resolve()
        self._shared = shared_dir.resolve()
        self._allow_write_shared = allow_write_shared

    def is_read_denied(self, filepath: str | Path) -> bool:
        p = Path(filepath).resolve()
        name = p.name.lower()

        if is_deny_read_path(p, self._personal):
            return True

        # Block sensitive names regardless of location
        if name in DENIED_BASENAMES:
            return True
        for pattern in DENIED_GLOBS:
            if fnmatch.fnmatch(name, pattern):
                return True
        for part in p.parts:
            if part.lower() in DENIED_DIRECTORIES:
                return True

        if is_under_root(p, self._personal) or is_under_root(p, self._shared):
            return False

        return True

    def is_write_denied(self, filepath: str | Path) -> bool:
        p = Path(filepath).resolve()

        if is_under_root(p, self._personal):
            return False  # always allowed in personal workspace

        if is_under_root(p, self._shared):
            return not self._allow_write_shared  # admin only

        return True  # deny everywhere else


# ── Code content scanning ────────────────────────────────────────────────

_SENSITIVE_PATH_RE = re.compile(
    r"""(?:\bread_csv|\bread_json|\bread_sql|\bread_excel|\bload|\bopen|\bread_text|\bread_bytes|\bPath|\blistdir|\bwalk|\bglob)\s*\(\s*['"]([^'"]+)['"]""",
    re.IGNORECASE,
)


def scan_code_for_denied_paths(
    code: str,
    base_dir: str | Path | None = None,
    path_checker=None,
) -> list[str]:
    """Scan Python code for string literals that resolve to denied paths.

    Parameters
    ----------
    path_checker : callable(path) -> bool, optional
        Custom path check function. Defaults to the module-level
        is_path_denied(). Pass WorkspaceGuard.is_read_denied in
        multi-user sessions.
    """
    checker = path_checker if path_checker is not None else is_path_denied

    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []

    denied = []
    base = Path(base_dir).resolve() if base_dir else None

    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            val = node.value.strip()
            if not val:
                continue

            p = Path(val)
            # Resolve relative paths against base_dir if provided
            if not p.is_absolute() and base:
                try:
                    p = (base / p).resolve()
                except Exception:
                    continue

            if checker(p):
                denied.append(val)

    return denied
