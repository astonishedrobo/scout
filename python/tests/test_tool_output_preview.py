from scout.agent import preview_tool_output


def test_short_tool_output_is_unchanged():
    assert preview_tool_output("line one\nline two", max_chars=500) == "line one\nline two"


def test_truncated_tool_output_reports_hidden_lines_and_characters():
    content = "a" * 500 + "hidden one\nhidden two\nhidden three"

    preview = preview_tool_output(content, max_chars=500)

    assert preview.startswith("a" * 500)
    assert preview.endswith("… +3 more lines (34 characters hidden)")


def test_truncated_single_line_output_still_signals_more_content():
    assert preview_tool_output("abcdefgh", max_chars=5) == (
        "abcde\n\n… +1 more line (3 characters hidden)"
    )
