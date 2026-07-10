"""Session state sidecar for fork/restore parity."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def snapshot_path(sessions_dir: Path, session_id: str) -> Path:
    return sessions_dir / f"{session_id}.state.json"


def save_session_snapshot(
    sessions_dir: Path,
    session_id: str,
    *,
    grants: list[dict[str, Any]] | None = None,
    exec_rules: list[str] | None = None,
    active_profile: str | None = None,
    approval_mode: str = "ask_always",
    parent_session_id: str | None = None,
) -> None:
    sessions_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "session_id": session_id,
        "grants": grants or [],
        "exec_rules": exec_rules or [],
        "active_profile": active_profile,
        "approval_mode": approval_mode,
        "parent_session_id": parent_session_id,
    }
    snapshot_path(sessions_dir, session_id).write_text(
        json.dumps(data, indent=2) + "\n", encoding="utf-8",
    )


def load_session_snapshot(sessions_dir: Path, session_id: str) -> dict[str, Any] | None:
    path = snapshot_path(sessions_dir, session_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def copy_session_snapshot(
    sessions_dir: Path,
    parent_id: str,
    child_id: str,
    *,
    parent_session_id: str | None = None,
) -> None:
    snap = load_session_snapshot(sessions_dir, parent_id)
    if snap is None:
        snap = {
            "grants": [],
            "exec_rules": [],
            "active_profile": None,
            "approval_mode": "ask_always",
        }
    snap["session_id"] = child_id
    snap["parent_session_id"] = parent_session_id or parent_id
    save_session_snapshot(
        sessions_dir,
        child_id,
        grants=snap.get("grants"),
        exec_rules=snap.get("exec_rules"),
        active_profile=snap.get("active_profile"),
        approval_mode=snap.get("approval_mode", "ask_always"),
        parent_session_id=snap.get("parent_session_id"),
    )
