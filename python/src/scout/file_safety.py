"""Shared sensitive-name policy without importing the agent runtime."""

from __future__ import annotations

import fnmatch


DENIED_BASENAMES = frozenset({
    ".env", ".env.local", ".env.development", ".env.production",
    ".env.staging", ".env.test", ".env.dev", ".env.prod",
    ".npmrc", ".pypirc", ".netrc", ".pgpass", ".htpasswd",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
    "id_rsa.pub", "id_ed25519.pub",
    "config.yaml", "config.yml",
    "scout_users.db", "scout.db",
})

DENIED_GLOBS = (
    ".env*",
    "*secret*.json", "*secret*.yaml", "*secret*.yml",
    "*secret*.toml", "*secret*.cfg", "*secret*.ini",
    "*credential*.json", "*credential*.yaml", "*credential*.yml",
    "*credential*.toml",
    "service-account*.json",
)

DENIED_DIRECTORIES = frozenset({
    ".ssh", ".gnupg", ".aws", ".docker", ".scout", ".git",
    "node_modules", "__pycache__",
})


def is_name_denied(filename: str) -> bool:
    """Return whether a basename is too sensitive to list or serve."""
    lower = filename.casefold()
    return (
        lower in DENIED_BASENAMES
        or lower.startswith(".env")
        or any(fnmatch.fnmatch(lower, pattern) for pattern in DENIED_GLOBS)
    )
