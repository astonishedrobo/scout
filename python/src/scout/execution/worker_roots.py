"""Canonical three-namespace path contract for execution.

Namespaces
----------
* **Worker** — paths the execution-worker process can open() (policy, snapshots,
  mkdir). In Docker deploy: ``/srv/scout-source/users/{id}``.
* **Host** — bind-mount *sources* for the Docker daemon only. Never open() these
  inside a nested worker unless they happen to equal worker paths.
* **Sandbox** — paths inside the per-session sandbox container and in agent
  prompts: always ``/workspace`` and ``/shared``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

_USER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

SANDBOX_PERSONAL = Path("/workspace")
SANDBOX_SHARED = Path("/shared")
SANDBOX_CACHE_DIRNAME = ".scout-cache"


@dataclass(frozen=True)
class WorkerRootLayout:
    """Worker-visible roots plus stable sandbox mount targets."""

    users_parent: Path
    shared_root: Path
    personal_root: Path
    in_sandbox_personal: Path
    in_sandbox_shared: Path

    @property
    def worker_personal(self) -> Path:
        return self.personal_root

    @property
    def worker_shared(self) -> Path:
        return self.shared_root

    @property
    def sandbox_personal(self) -> Path:
        return self.in_sandbox_personal

    @property
    def sandbox_shared(self) -> Path:
        return self.in_sandbox_shared


@dataclass(frozen=True)
class ExecutionPathContext:
    """Full three-namespace context for one user execution."""

    user_id: str
    worker_personal: Path
    worker_shared: Path
    host_personal: Path
    host_shared: Path
    sandbox_personal: Path = SANDBOX_PERSONAL
    sandbox_shared: Path = SANDBOX_SHARED

    @property
    def worker_cache(self) -> Path:
        return self.worker_personal / SANDBOX_CACHE_DIRNAME

    @property
    def sandbox_cache(self) -> Path:
        return self.sandbox_personal / SANDBOX_CACHE_DIRNAME


def _env_path(name: str, default: str | None = None) -> Path | None:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        if default is None:
            return None
        raw = default
    return Path(raw).expanduser()


def worker_layout() -> tuple[Path, Path]:
    """Return (users_parent, shared_root) from worker environment."""
    users_parent = _env_path("SCOUT_WORKSPACE_USERS", "/srv/scout-source/users")
    shared_root = _env_path("SCOUT_WORKSPACE_SHARED", "/srv/scout-source/shared")
    assert users_parent is not None and shared_root is not None
    return users_parent.resolve(), shared_root.resolve()


def host_workspace_paths(*, require_host: bool = False) -> tuple[Path, Path]:
    """Return Docker-daemon bind sources for users parent and shared.

    When *require_host* is True (container isolation), both
    ``SCOUT_WORKSPACE_USERS_HOST`` and ``SCOUT_WORKSPACE_SHARED_HOST`` must be
    set. Local non-nested runs may fall back to worker paths.
    """
    users_host = _env_path("SCOUT_WORKSPACE_USERS_HOST")
    shared_host = _env_path("SCOUT_WORKSPACE_SHARED_HOST")
    if users_host is None or shared_host is None:
        if require_host:
            missing = [
                name
                for name, val in (
                    ("SCOUT_WORKSPACE_USERS_HOST", users_host),
                    ("SCOUT_WORKSPACE_SHARED_HOST", shared_host),
                )
                if val is None
            ]
            raise RuntimeError(
                "Container isolation requires host bind paths: "
                + ", ".join(missing)
            )
        worker_users, worker_shared = worker_layout()
        users_host = users_host or worker_users
        shared_host = shared_host or worker_shared
    return users_host, shared_host


def validate_user_id(user_id: str) -> None:
    if not user_id or not _USER_ID_RE.match(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")


def _reject_symlink_escape(path: Path, parent: Path) -> None:
    resolved = path.resolve()
    parent_resolved = parent.resolve()
    try:
        resolved.relative_to(parent_resolved)
    except ValueError as exc:
        raise ValueError(f"Path escapes parent: {path}") from exc
    if path.is_symlink():
        target = path.resolve()
        try:
            target.relative_to(parent_resolved)
        except ValueError as exc:
            raise ValueError(f"Symlink escapes parent: {path} -> {target}") from exc


def derive_user_roots(user_id: str) -> WorkerRootLayout:
    """Derive worker-visible roots for *user_id*; never trust caller paths."""
    validate_user_id(user_id)
    users_parent, shared_root = worker_layout()

    if not users_parent.is_dir():
        raise ValueError(f"Users parent missing: {users_parent}")
    if not shared_root.is_dir():
        raise ValueError(f"Shared root missing: {shared_root}")

    personal = (users_parent / user_id).resolve()
    _reject_symlink_escape(personal, users_parent.resolve())

    if not personal.is_dir():
        raise ValueError(f"Personal workspace missing for user {user_id}: {personal}")

    shared = shared_root.resolve()
    _reject_symlink_escape(shared, shared_root.parent.resolve())

    return WorkerRootLayout(
        users_parent=users_parent.resolve(),
        shared_root=shared,
        personal_root=personal,
        in_sandbox_personal=SANDBOX_PERSONAL,
        in_sandbox_shared=SANDBOX_SHARED,
    )


def path_context_for_user(
    user_id: str,
    *,
    require_host: bool = False,
) -> ExecutionPathContext:
    """Build the full path context for *user_id*."""
    layout = derive_user_roots(user_id)
    host_users, host_shared = host_workspace_paths(require_host=require_host)
    return ExecutionPathContext(
        user_id=user_id,
        worker_personal=layout.personal_root,
        worker_shared=layout.shared_root,
        host_personal=Path(host_users) / user_id,
        host_shared=Path(host_shared),
        sandbox_personal=layout.in_sandbox_personal,
        sandbox_shared=layout.in_sandbox_shared,
    )


def path_context_from_layout(
    layout: WorkerRootLayout,
    *,
    user_id: str,
    require_host: bool = False,
) -> ExecutionPathContext:
    host_users, host_shared = host_workspace_paths(require_host=require_host)
    return ExecutionPathContext(
        user_id=user_id,
        worker_personal=layout.personal_root,
        worker_shared=layout.shared_root,
        host_personal=Path(host_users) / user_id,
        host_shared=Path(host_shared),
        sandbox_personal=layout.in_sandbox_personal,
        sandbox_shared=layout.in_sandbox_shared,
    )


def worker_to_sandbox(path: Path | str, ctx: ExecutionPathContext) -> Path:
    """Map a worker-visible absolute path into sandbox coordinates."""
    resolved = Path(path)
    try:
        resolved = resolved.resolve()
    except OSError:
        resolved = Path(path)
    try:
        rel = resolved.relative_to(ctx.worker_personal.resolve())
        return ctx.sandbox_personal / rel
    except ValueError:
        pass
    try:
        rel = resolved.relative_to(ctx.worker_shared.resolve())
        return ctx.sandbox_shared / rel
    except ValueError:
        pass
    # Already sandbox-shaped?
    if str(resolved).startswith(str(ctx.sandbox_personal)) or str(resolved).startswith(
        str(ctx.sandbox_shared)
    ):
        return resolved
    return resolved


def sandbox_to_worker(path: Path | str, ctx: ExecutionPathContext) -> Path:
    """Map a sandbox or relative path to a worker-visible path."""
    p = Path(path)
    if not p.is_absolute():
        return (ctx.worker_personal / p).resolve()
    try:
        rel = p.relative_to(ctx.sandbox_personal)
        return (ctx.worker_personal / rel).resolve()
    except ValueError:
        pass
    try:
        rel = p.relative_to(ctx.sandbox_shared)
        return (ctx.worker_shared / rel).resolve()
    except ValueError:
        pass
    return p


def map_roots_for_sandbox(layout: WorkerRootLayout) -> tuple[Path, Path, Path, Path]:
    """Return (worker_personal, sandbox_personal, worker_shared, sandbox_shared).

    Name kept for call-sites; values are worker + sandbox, never host binds.
    """
    return (
        layout.personal_root,
        layout.in_sandbox_personal,
        layout.shared_root,
        layout.in_sandbox_shared,
    )
