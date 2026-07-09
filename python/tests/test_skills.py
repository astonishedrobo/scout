import logging

from scout.skills import load_layered_instructions


def test_missing_layered_instruction_files_do_not_warn(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="scout.skills")

    assert load_layered_instructions(tmp_path) == ""
    assert "Could not read" not in caplog.text
