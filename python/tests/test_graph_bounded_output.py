from scout.agent.graph import bounded_text


def test_bounded_text_keeps_head_tail_and_hard_limit():
    text = "COMMAND\n" + ("middle-data\n" * 1000) + "FINAL ERROR: disk full"

    result = bounded_text(text, 300)

    assert len(result) <= 300
    assert result.startswith("COMMAND\n")
    assert result.endswith("FINAL ERROR: disk full")
    assert "characters omitted" in result


def test_bounded_text_leaves_short_content_unchanged():
    assert bounded_text("complete output", 100) == "complete output"
