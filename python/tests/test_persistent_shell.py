"""Tests for persistent shell session (unit-level)."""

from scout.execution.persistent_shell import _SHELL_LOOP, _INPUT_END, _OUTPUT_END


def test_shell_loop_script_contains_sentinels():
    assert _INPUT_END in _SHELL_LOOP
    assert _OUTPUT_END in _SHELL_LOOP
