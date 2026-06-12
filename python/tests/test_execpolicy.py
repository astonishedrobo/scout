"""Tests for execpolicy."""

from scout.execution.execpolicy import PolicyMatch, add_rule, match_policy, validate_prefix


def test_validate_prefix_rejects_rm():
    assert validate_prefix("rm -rf /") is not None


def test_match_policy_allows_saved_prefix(tmp_path):
    add_rule("pytest ", personal_dir=tmp_path, server_mode=True)
    assert match_policy("pytest tests/", personal_dir=tmp_path, server_mode=True) == PolicyMatch.ALLOW


def test_match_policy_prompts_unknown():
    assert match_policy("unknown-cmd", personal_dir=None, server_mode=False) == PolicyMatch.PROMPT
