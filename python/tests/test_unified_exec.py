"""Tests for Codex-style unified exec."""

from scout.execution.unified_exec import (
    clamp_yield_time,
    format_tool_response,
    HeadTailBuffer,
    MIN_YIELD_TIME_MS,
    MAX_YIELD_TIME_MS,
)


def test_clamp_yield_time_default():
    assert clamp_yield_time(0) == 10_000 or clamp_yield_time(0) >= MIN_YIELD_TIME_MS
    assert clamp_yield_time(100_000) == MAX_YIELD_TIME_MS
    assert clamp_yield_time(100) == MIN_YIELD_TIME_MS


def test_clamp_empty_poll():
    assert clamp_yield_time(1000, empty_poll=True, max_poll_ms=60_000) >= 5_000


def test_format_tool_response_running():
    text = format_tool_response(
        "hello",
        wall_time_seconds=1.5,
        process_id=2,
        max_output_tokens=100,
    )
    assert "session ID 2" in text
    assert "hello" in text
    assert "Wall time" in text


def test_format_tool_response_exited():
    text = format_tool_response(
        "done",
        wall_time_seconds=0.5,
        exit_code=0,
    )
    assert "exit code 0" in text.lower() or "exited with code 0" in text


def test_head_tail_buffer_truncates():
    buf = HeadTailBuffer(max_bytes=50)
    buf.append(b"x" * 40)
    buf.append(b"y" * 40)
    snap = buf.snapshot()
    assert len(snap) <= 60
