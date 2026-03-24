"""Application-level file access guard.

Blocks reading sensitive files regardless of whether the OS-level sandbox
is active.  This is defense-in-depth: even if the sandbox fails to
initialize (e.g. missing socat/bwrap), these rules still apply.

The guard is enforced at the tool layer -- every tool that touches
the filesystem (read_file, list_files, read_pdf, run_code) checks
paths through this module before proceeding.
"""

from __future__ import annotations

import ast
import fnmatch
import os
import re
from pathlib import Path

# ── Sensitive filename patterns ──────────────────────────────────────────

DENIED_BASENAMES = {
    ".env", ".env.local", ".env.development", ".env.production",
    ".env.staging", ".env.test", ".env.dev", ".env.prod",
    ".npmrc", ".pypirc", ".netrc", ".pgpass", ".htpasswd",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
    "id_rsa.pub", "id_ed25519.pub",
    "config.yaml", "config.yml",
    "scout_users.db", "scout.db",
}

DENIED_GLOBS = [
    ".env*",
    "*secret*.json", "*secret*.yaml", "*secret*.yml",
    "*secret*.toml", "*secret*.cfg", "*secret*.ini",
    "*credential*.json", "*credential*.yaml", "*credential*.yml",
    "*credential*.toml",
    "service-account*.json",
]

DENIED_DIRECTORIES = {
    ".ssh", ".gnupg", ".aws", ".docker", ".scout", ".git",
    "node_modules", "__pycache__",
}

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
    # This MUST come before the /app/workspace early return
    for part in p.parts:
        if part.lower() in DENIED_DIRECTORIES:
            return True

    # Allow everything inside the workspace ONLY if not in a denied dir (checked above)
    if abs_str.startswith("/app/workspace"):
        return False

    # Absolute prefix match (home dir secrets)
    for prefix in DENIED_ABSOLUTE_PREFIXES:
        if abs_str.startswith(prefix):
            return True

    return False


def is_name_denied(filename: str) -> bool:
    """Check just a filename (no path resolution) for listing filters."""
    lower = filename.lower()
    if lower in DENIED_BASENAMES:
        return True
    if lower.startswith(".env"):
        return True
    for pattern in DENIED_GLOBS:
        if fnmatch.fnmatch(lower, pattern):
            return True
    return False


# ── Code content scanning ────────────────────────────────────────────────

_SENSITIVE_PATH_RE = re.compile(
    r"""(?:\bread_csv|\bread_json|\bread_sql|\bread_excel|\bload|\bopen|\bread_text|\bread_bytes|\bPath|\blistdir|\bwalk|\bglob)\s*\(\s*['"]([^'"]+)['"]""",
    re.IGNORECASE,
)

def scan_code_for_denied_paths(code: str, base_dir: str | Path | None = None) -> list[str]:
    """Scan Python code for string literals that resolve to denied paths."""
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
            
            if is_path_denied(p):
                denied.append(val)
    
    return denied
