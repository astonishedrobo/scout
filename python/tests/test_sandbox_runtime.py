"""Tests for shared sandbox runtime resolution and env enrichment."""

from pathlib import Path

import pytest

from scout.execution.policy import build_execution_environment
from scout.execution.runtime import (
    enrich_execution_env,
    prepare_user_package_dir,
    resolve_sandbox_python,
)


def test_resolve_sandbox_python_prefers_explicit_path(tmp_path: Path):
    py = tmp_path / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/sh\n")
    assert resolve_sandbox_python(str(py)) == str(py)


def test_resolve_sandbox_python_falls_back_to_sys_executable():
    import sys
    assert resolve_sandbox_python(None) == sys.executable
    assert resolve_sandbox_python("/nonexistent/python") == sys.executable


def test_prepare_user_package_dir_creates_directory(tmp_path: Path):
    cache = tmp_path / ".scout-cache"
    pkg_dir = prepare_user_package_dir(cache)
    assert pkg_dir == cache / "python-packages"
    assert pkg_dir.is_dir()


def test_enrich_execution_env_sets_path_pip_target_and_pythonpath(tmp_path: Path):
    cache = tmp_path / ".scout-cache"
    sandbox_python = str(tmp_path / "env" / "bin" / "python3")
    Path(sandbox_python).parent.mkdir(parents=True)
    Path(sandbox_python).write_text("")

    env = enrich_execution_env(
        {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)},
        sandbox_python=sandbox_python,
        cache_dir=cache,
    )

    assert env["PIP_TARGET"] == str((cache / "python-packages").resolve())
    assert env["PYTHONPATH"] == str((cache / "python-packages").resolve())
    assert env["PATH"].startswith(str(Path(sandbox_python).resolve().parent))


def test_build_execution_environment_applies_runtime_enrichment(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    personal.mkdir(parents=True)
    env = build_execution_environment(personal, sandbox_python=str(Path("/usr/bin/python3")))

    pkg_dir = personal / ".scout-cache" / "python-packages"
    assert env["PIP_TARGET"] == str(pkg_dir.resolve())
    assert env["PYTHONPATH"] == str(pkg_dir.resolve())
    assert "/usr/bin" in env["PATH"]
