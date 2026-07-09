"""Minimal environment construction for execution (worker FS and sandbox)."""

from __future__ import annotations

import os
from pathlib import Path

from .runtime import USER_PACKAGE_DIR_NAME, prepare_user_package_dir
from .worker_roots import ExecutionPathContext, SANDBOX_CACHE_DIRNAME

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
    "UV_CACHE_DIR",
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

# Keys whose values are single filesystem paths (safe to rewrite worker→sandbox).
_PATH_ENV_KEYS = frozenset({
    "HOME",
    "MPLCONFIGDIR",
    "XDG_CACHE_HOME",
    "UV_CACHE_DIR",
    "NUMBA_CACHE_DIR",
    "NPM_CONFIG_CACHE",
    "PIP_CACHE_DIR",
    "PIP_TARGET",
    "PYTHONPATH",
    "NODE_PATH",
})

_CACHE_SUBDIRS = (
    "home",
    "matplotlib",
    "xdg",
    "uv",
    "numba",
    "pip",
    "npm",
    USER_PACKAGE_DIR_NAME,
)


def materialize_user_cache(cache_dir: Path) -> Path:
    """Create the standard per-user cache tree on a *worker-visible* path."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    for name in _CACHE_SUBDIRS:
        (cache_dir / name).mkdir(parents=True, exist_ok=True)
    prepare_user_package_dir(cache_dir)
    return cache_dir


def _base_runtime_env(
    *,
    home: str,
    cache_prefix: str,
    package_dir: str,
    extra: dict[str, str] | None = None,
    inherit_path: bool = True,
) -> dict[str, str]:
    env: dict[str, str] = {}
    if inherit_path:
        for key in ALLOWED_ENV_KEYS:
            val = os.environ.get(key)
            if val is not None:
                env[key] = val

    env["HOME"] = home
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["MPLBACKEND"] = "Agg"
    env["MPLCONFIGDIR"] = f"{cache_prefix}/matplotlib"
    env["XDG_CACHE_HOME"] = f"{cache_prefix}/xdg"
    env["UV_CACHE_DIR"] = f"{cache_prefix}/uv"
    env["NUMBA_CACHE_DIR"] = f"{cache_prefix}/numba"
    env["PIP_CACHE_DIR"] = f"{cache_prefix}/pip"
    env["NPM_CONFIG_CACHE"] = f"{cache_prefix}/npm"
    env["PYTHONPATH"] = package_dir
    env["PIP_TARGET"] = package_dir
    # Container images already have a correct PATH; avoid leaking worker PATH.
    if not inherit_path:
        env["PATH"] = env.get("PATH") or "/usr/local/bin:/usr/bin:/bin"

    if extra:
        for key, val in extra.items():
            if key in ALLOWED_ENV_KEYS:
                env[key] = val
    return env


def build_execution_env(
    *,
    home: Path,
    cache_dir: Path,
    extra: dict[str, str] | None = None,
    materialize: bool = True,
) -> dict[str, str]:
    """Build a scrubbed env for *worker/local* execution (bwrap, host process).

    When *materialize* is True, cache directories are created under *cache_dir*
    (must be worker-visible).
    """
    cache_dir = Path(cache_dir)
    home = Path(home)
    if materialize:
        materialize_user_cache(cache_dir)
        home.mkdir(parents=True, exist_ok=True)
        pkg_dir = str(prepare_user_package_dir(cache_dir).resolve())
    else:
        pkg_dir = str((cache_dir / USER_PACKAGE_DIR_NAME).resolve())

    return _base_runtime_env(
        home=str(home),
        cache_prefix=str(cache_dir),
        package_dir=pkg_dir,
        extra=extra,
        inherit_path=True,
    )


def build_sandbox_execution_env(
    ctx: ExecutionPathContext,
    *,
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    """Env for processes *inside* the sandbox container.

    Paths are always sandbox coordinates (``/workspace/...``). Cache dirs are
    materialized on the worker-visible volume so the bind mount is real.
    """
    materialize_user_cache(ctx.worker_cache)
    sandbox_cache = str(ctx.sandbox_cache)
    home = f"{sandbox_cache}/home"
    pkg = f"{sandbox_cache}/{USER_PACKAGE_DIR_NAME}"
    return _base_runtime_env(
        home=home,
        cache_prefix=sandbox_cache,
        package_dir=pkg,
        extra=extra,
        inherit_path=False,
    )


def cache_dir_name() -> str:
    return SANDBOX_CACHE_DIRNAME
