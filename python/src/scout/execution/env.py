"""Minimal environment allowlist for execution workers."""

from __future__ import annotations

import os
from pathlib import Path

from .runtime import prepare_user_package_dir

ALLOWED_ENV_KEYS = frozenset({
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_NUMERIC",
    "LC_TIME",
    "PYTHONIOENCODING",
    "PYTHONUNBUFFERED",
    "MPLBACKEND",
    "MPLCONFIGDIR",
    "XDG_CACHE_HOME",
    "NUMBA_CACHE_DIR",
    "NODE_PATH",
    "NPM_CONFIG_CACHE",
    "PIP_CACHE_DIR",
    "PIP_TARGET",
    "PYTHONPATH",
    "TERM",
    "TZ",
    "USER",
    "LOGNAME",
})


def build_execution_env(
    *,
    home: Path,
    cache_dir: Path,
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build a scrubbed environment dict using an allowlist."""
    env: dict[str, str] = {}
    for key in ALLOWED_ENV_KEYS:
        val = os.environ.get(key)
        if val is not None:
            env[key] = val

    env["HOME"] = str(home)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["MPLBACKEND"] = "Agg"
    env["MPLCONFIGDIR"] = str(cache_dir / "matplotlib")
    env["XDG_CACHE_HOME"] = str(cache_dir / "xdg")
    env["NUMBA_CACHE_DIR"] = str(cache_dir / "numba")
    env["PIP_CACHE_DIR"] = str(cache_dir / "pip")
    env["NPM_CONFIG_CACHE"] = str(cache_dir / "npm")

    # Persist pip installs to the mounted user cache and make them importable.
    # Container-backend sessions only call build_execution_env (not
    # enrich_execution_env), so without this run_python cannot import packages
    # that exec_command's `pip install` placed in `.scout-cache/python-packages`.
    pkg_dir = str(prepare_user_package_dir(cache_dir).resolve())
    env["PYTHONPATH"] = pkg_dir
    env["PIP_TARGET"] = pkg_dir

    for path in (
        env["MPLCONFIGDIR"],
        env["XDG_CACHE_HOME"],
        env["NUMBA_CACHE_DIR"],
        env["PIP_CACHE_DIR"],
        env["NPM_CONFIG_CACHE"],
    ):
        Path(path).mkdir(parents=True, exist_ok=True)

    if extra:
        for key, val in extra.items():
            if key in ALLOWED_ENV_KEYS:
                env[key] = val

    return env
