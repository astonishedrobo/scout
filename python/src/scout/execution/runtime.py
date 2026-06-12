"""Shared sandbox runtime resolution for shell and Python execution."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

USER_PACKAGE_DIR_NAME = "python-packages"


def resolve_sandbox_python(python_path: str | None) -> str:
    """Return the Python interpreter used for run_python and shell commands."""
    if python_path and Path(python_path).exists():
        return python_path
    return sys.executable


def prepare_user_package_dir(cache_dir: Path) -> Path:
    """Ensure the writable pip target directory exists under the user cache."""
    pkg_dir = cache_dir / USER_PACKAGE_DIR_NAME
    pkg_dir.mkdir(parents=True, exist_ok=True)
    return pkg_dir


def enrich_execution_env(
    base_env: dict[str, str],
    *,
    sandbox_python: str,
    cache_dir: Path,
) -> dict[str, str]:
    """Augment execution env with sandbox Python PATH and writable pip target."""
    env = dict(base_env)
    pkg_dir = prepare_user_package_dir(cache_dir)
    pkg_path = str(pkg_dir.resolve())

    path_prefixes: list[str] = [str(Path(sandbox_python).resolve().parent)]
    node_binary = shutil.which("node")
    if node_binary:
        path_prefixes.append(str(Path(node_binary).resolve().parent))

    existing_path = env.get("PATH", "/usr/bin:/bin")
    env["PATH"] = os.pathsep.join(path_prefixes + [existing_path])
    env["PYTHONPATH"] = pkg_path
    env["PIP_TARGET"] = pkg_path
    return env
