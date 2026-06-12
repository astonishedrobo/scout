"""Lifecycle hook runner (hooks.json). codex-parity: partial"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

logger = logging.getLogger(__name__)

HookName = Literal[
    "PreToolUse", "PostToolUse", "PreCompact", "SessionStart", "UserPromptSubmit",
]

_XDG_CONFIG = Path.home() / ".config" / "scout"


@dataclass
class HookResult:
    blocked: bool = False
    message: str = ""
    mutated_input: dict[str, Any] | None = None


def hooks_config_path(
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> Path:
    if server_mode and personal_dir:
        return Path(personal_dir) / ".scout" / "hooks.json"
    return _XDG_CONFIG / "hooks.json"


def _load_hooks(path: Path) -> dict[str, list[dict[str, str]]]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("hooks", data) if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read hooks %s: %s", path, exc)
        return {}


def run_hook(
    name: HookName,
    payload: dict[str, Any],
    *,
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
    enabled: bool = True,
) -> HookResult:
    if not enabled:
        return HookResult()
    path = hooks_config_path(personal_dir, server_mode)
    hooks = _load_hooks(path)
    entries = hooks.get(name, [])
    if not entries:
        return HookResult()

    stdin_data = json.dumps({"hook": name, **payload})
    for entry in entries:
        cmd = entry.get("command") or entry.get("cmd")
        if not cmd:
            continue
        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                input=stdin_data,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.warning("Hook %s failed: %s", name, exc)
            continue
        if proc.returncode == 2:
            msg = proc.stdout.strip() or proc.stderr.strip() or "Blocked by hook"
            return HookResult(blocked=True, message=msg)
        if proc.stdout.strip():
            try:
                out = json.loads(proc.stdout)
                if out.get("block"):
                    return HookResult(blocked=True, message=str(out.get("message", "")))
                if "mutated_input" in out:
                    return HookResult(mutated_input=out["mutated_input"])
            except json.JSONDecodeError:
                pass
    return HookResult()
