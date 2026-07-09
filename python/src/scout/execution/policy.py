"""Server-side execution policy builder."""

from __future__ import annotations

from pathlib import Path

from ..config import ExecutionConfig
from .env import build_execution_env
from .models import ExecutionPolicy, NetworkPolicy
from .runtime import enrich_execution_env, resolve_sandbox_python
from .path_utils import is_under_root

_PROTECTED_WRITE_GLOBS = (".git", ".scout")
_DENY_READ_NAMES = frozenset({
    ".env", ".env.local", ".env.development", ".env.production",
    ".env.staging", ".env.test", ".env.dev", ".env.prod",
    "scout_users.db", "scout.db",
})


def build_execution_policy(
    *,
    personal_dir: Path,
    shared_dir: Path | None,
    config: ExecutionConfig,
    allow_shared_write: bool = False,
    personal_write: bool = False,
    network_domains: tuple[str, ...] = (),
    staging_dir: Path | None = None,
    scratch_dir: Path | None = None,
    persistent: bool = False,
) -> ExecutionPolicy:
    """Build an execution policy from authenticated server context."""
    personal = personal_dir.resolve()
    cache = personal / ".scout-cache"
    read_roots: list[Path] = [personal, cache]
    write_roots: list[Path] = [cache]
    if personal_write:
        write_roots.append(personal)

    if scratch_dir is not None:
        scratch = scratch_dir.resolve()
        scratch.mkdir(parents=True, exist_ok=True)
        read_roots.append(scratch)
        write_roots.append(scratch)

    if persistent:
        pass
    elif staging_dir is not None:
        staging = staging_dir.resolve()
        read_roots.append(staging)
        write_roots = [staging, cache]
        if scratch_dir is not None:
            write_roots.append(scratch_dir.resolve())

    if shared_dir is not None:
        shared = shared_dir.resolve()
        read_roots.append(shared)
        if allow_shared_write:
            write_roots.append(shared)

    denied: list[Path] = []
    for part in _PROTECTED_WRITE_GLOBS:
        candidate = personal / part
        if candidate.exists():
            denied.append(candidate)
    for name in _DENY_READ_NAMES:
        candidate = personal / name
        if candidate.exists():
            denied.append(candidate)

    network = (
        NetworkPolicy(mode="allow_domains", domains=network_domains)
        if network_domains
        else NetworkPolicy(mode=config.network_default)  # type: ignore[arg-type]
    )

    return ExecutionPolicy(
        read_roots=tuple(dict.fromkeys(read_roots)),
        write_roots=tuple(dict.fromkeys(write_roots)),
        denied_roots=tuple(dict.fromkeys(denied)),
        network=network,
        timeout_seconds=config.timeout_seconds,
        max_output_bytes=config.max_output_bytes,
        max_memory_bytes=config.max_memory_mb * 1024 * 1024 if config.max_memory_mb else None,
        max_processes=config.max_processes,
        cpu_seconds=config.timeout_seconds,
    )


def build_execution_environment(
    personal_dir: Path,
    extra: dict[str, str] | None = None,
    *,
    sandbox_python: str | None = None,
) -> dict[str, str]:
    cache = personal_dir / ".scout-cache"
    exec_home = cache / "home"
    exec_home.mkdir(parents=True, exist_ok=True)
    env = build_execution_env(home=exec_home, cache_dir=cache, extra=extra)
    python = resolve_sandbox_python(sandbox_python)
    return enrich_execution_env(env, sandbox_python=python, cache_dir=cache)


def is_deny_read_path(path: Path, workspace_root: Path) -> bool:
    """Block reads of sensitive paths even when under workspace."""
    name = path.name.lower()
    if name in _DENY_READ_NAMES or name.startswith(".env"):
        return True
    if name == "scout_users.db":
        return True
    if ".git" in path.parts and path.name not in {".gitkeep"}:
        return is_under_root(path, workspace_root)
    for denied_name in _PROTECTED_WRITE_GLOBS:
        if path.name == denied_name and is_under_root(path, workspace_root):
            return True
    return False


def _is_denied_root(path: Path, denied_roots: tuple[Path, ...]) -> bool:
    resolved = path.resolve()
    for denied in denied_roots:
        d = denied.resolve()
        if resolved == d or is_under_root(resolved, d):
            return True
    return False


# Directories excluded from bwrap bind expansion (keeps argv small; not needed in sandbox).
_SKIP_BIND_DIR_NAMES = frozenset({
    "node_modules",
    "__pycache__",
    ".git",
    ".venv",
    "venv",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
})


def _skip_bind_dir(path: Path) -> bool:
    return path.name in _SKIP_BIND_DIR_NAMES


def _contains_blocked_subpath(
    path: Path,
    workspace_root: Path,
    denied_roots: tuple[Path, ...],
) -> bool:
    """Return True if *path* or any descendant must not be covered by a single bind."""
    if is_deny_read_path(path, workspace_root) or _is_denied_root(path, denied_roots):
        return True
    if path.is_dir() and _skip_bind_dir(path):
        return True
    if not path.is_dir():
        return False
    try:
        for child in path.iterdir():
            if _contains_blocked_subpath(child, workspace_root, denied_roots):
                return True
    except OSError:
        return True
    return False


def safe_read_bind_paths(
    root: Path,
    workspace_root: Path,
    denied_roots: tuple[Path, ...],
) -> list[Path]:
    """Expand a read root into bind mount targets (directories or loose files).

    Uses directory-level binds where safe so bubblewrap argv stays well below
    ``ARG_MAX``. Sensitive paths (``.env``, ``.git``, denied roots) and heavy
    trees (``node_modules``, etc.) are still excluded.
    """
    root = root.resolve()
    workspace_root = workspace_root.resolve()

    if _is_denied_root(root, denied_roots):
        return []

    if not root.exists():
        return []

    if root.is_file():
        return [] if is_deny_read_path(root, workspace_root) else [root]

    if root != workspace_root and not is_under_root(root, workspace_root):
        return [root]

    binds: list[Path] = []
    try:
        children = sorted(root.iterdir())
    except OSError:
        return [root]

    for child in children:
        if is_deny_read_path(child, workspace_root) or _is_denied_root(child, denied_roots):
            continue
        if child.is_dir() and _skip_bind_dir(child):
            continue
        if child.is_dir() and not _contains_blocked_subpath(child, workspace_root, denied_roots):
            binds.append(child)
        else:
            binds.extend(safe_read_bind_paths(child, workspace_root, denied_roots))
    return binds


# Directory / tree names that are never user deliverables (install caches, venvs).
_IGNORED_PATH_PARTS = frozenset({
    ".scout-cache",
    ".scout-executions",
    ".local",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "site-packages",
})

# Suffixes / names for package install metadata noise.
_IGNORED_NAME_SUFFIXES = (
    ".dist-info",
    ".egg-info",
    ".pyc",
    ".pyo",
)


def is_ignored_execution_path(path: Path, workspace_root: Path) -> bool:
    """Return True for cache/install trees that must not surface as changes/artifacts.

    Intentional user dotfiles (e.g. ``.gitignore``) are *not* ignored.
    """
    rel_parts: tuple[str, ...] = ()
    try:
        rel = path.resolve().relative_to(workspace_root.resolve())
        rel_parts = rel.parts
    except ValueError:
        rel_parts = path.parts

    if any(part in _IGNORED_PATH_PARTS for part in rel_parts):
        return True
    if any(
        part.endswith(_IGNORED_NAME_SUFFIXES) or path.name.endswith(_IGNORED_NAME_SUFFIXES)
        for part in rel_parts
    ):
        return True
    name = path.name
    if name in {"uv.lock", ".python-version"} and ".scout-cache" in rel_parts:
        return True
    return False
