"""Tests for lifecycle hooks runner."""

import json
from pathlib import Path

from scout.hooks import run_hook


def test_pretooluse_can_block(tmp_path: Path):
    scout_dir = tmp_path / ".scout"
    scout_dir.mkdir(parents=True, exist_ok=True)
    hooks = {
        "PreToolUse": [{"command": "python3 -c 'import sys; sys.exit(2)'"}],
    }
    (scout_dir / "hooks.json").write_text(json.dumps({"hooks": hooks}), encoding="utf-8")
    result = run_hook(
        "PreToolUse",
        {"tool_name": "write_file", "tool_input": {}},
        personal_dir=tmp_path,
        server_mode=True,
    )
    assert result.blocked
