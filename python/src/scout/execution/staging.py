"""Execution staging directory management."""

from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from ..agent.file_tracker import FileDiff, exact_file_diff


@dataclass
class ExecutionStaging:
    execution_id: str
    root: Path
    work_dir: Path
    tmp_dir: Path
    metadata_path: Path


def create_staging(personal_dir: Path) -> ExecutionStaging:
    """Create `.scout-executions/{execution_id}/` staging layout."""
    execution_id = uuid.uuid4().hex
    root = personal_dir / ".scout-executions" / execution_id
    work = root / "work"
    tmp = root / "tmp"
    work.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(parents=True, exist_ok=True)
    meta = root / "metadata.json"
    meta.write_text(json.dumps({"execution_id": execution_id}), encoding="utf-8")
    return ExecutionStaging(execution_id, root, work, tmp, meta)


def _file_hash(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_promotion_conflicts(
    staging: ExecutionStaging,
    workspace_root: Path,
) -> list[FileDiff]:
    """Detect workspace files that changed after staging began."""
    conflicts: list[FileDiff] = []
    pre_hashes: dict[str, str | None] = {}
    if staging.metadata_path.exists():
        try:
            meta = json.loads(staging.metadata_path.read_text(encoding="utf-8"))
            pre_hashes = meta.get("pre_hashes", {})
        except (json.JSONDecodeError, OSError):
            pre_hashes = {}

    for src in staging.work_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = str(src.relative_to(staging.work_dir))
        dest = workspace_root / rel
        pre = pre_hashes.get(rel)
        current = _file_hash(dest) if dest.exists() else None
        if pre is not None and current is not None and pre != current:
            conflicts.append(exact_file_diff(
                dest, workspace_root,
                None, src.read_bytes(),
            ))
    return conflicts


def snapshot_pre_promotion_hashes(staging: ExecutionStaging, workspace_root: Path) -> None:
    """Record workspace hashes before execution for conflict detection."""
    pre_hashes: dict[str, str | None] = {}
    for src in staging.work_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = str(src.relative_to(staging.work_dir))
        dest = workspace_root / rel
        pre_hashes[rel] = _file_hash(dest) if dest.exists() else None
    meta = {"execution_id": staging.execution_id, "pre_hashes": pre_hashes}
    staging.metadata_path.write_text(json.dumps(meta), encoding="utf-8")


def promote_staged_files(
    staging: ExecutionStaging,
    workspace_root: Path,
    *,
    target_root: Path | None = None,
) -> list[tuple[Path, Path]]:
    """Copy staged files from work/ into the live workspace."""
    target = target_root or workspace_root
    promoted: list[tuple[Path, Path]] = []
    for src in staging.work_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(staging.work_dir)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        promoted.append((src, dest))
    return promoted


def discard_staging(staging: ExecutionStaging) -> None:
    if staging.root.exists():
        shutil.rmtree(staging.root, ignore_errors=True)
