"""Centralized secret loading from Docker secrets with environment fallback."""

from __future__ import annotations

import os
from pathlib import Path


def load_secret(name: str, default: str = "") -> str:
    file_var = f"{name}_FILE"
    candidates = []
    if os.environ.get(file_var):
        candidates.append(Path(os.environ[file_var]))
    candidates.append(Path("/run/secrets") / name.lower())
    for path in candidates:
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value
    return os.environ.get(name, default)


def require_production_secret(name: str, insecure_values: set[str]) -> str:
    value = load_secret(name)
    if os.environ.get("SCOUT_ENV", "").lower() in {"production", "prod"}:
        if not value or value in insecure_values:
            raise RuntimeError(f"{name} must be securely configured in production")
    return value
