"""Tests for Codex-style unified exec."""

import threading
import time
from types import SimpleNamespace

from scout.config import ExecutionConfig

from scout.execution.unified_exec import (
    clamp_yield_time,
    format_tool_response,
    HeadTailBuffer,
    MIN_YIELD_TIME_MS,
    MAX_YIELD_TIME_MS,
    UnifiedExecManager,
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


def test_stream_consumer_can_arrive_before_command_registration():
    manager = UnifiedExecManager(ExecutionConfig())
    received = []
    consumer = threading.Thread(
        target=lambda: received.extend(manager.iter_stream("exec-1", timeout=0.01))
    )
    consumer.start()
    time.sleep(0.02)

    stream = manager.register_stream("exec-1")
    stream.put_nowait("hello")
    manager._finish_stream(stream)
    consumer.join(timeout=1)

    assert not consumer.is_alive()
    assert received == ["hello"]
    manager.unregister_stream("exec-1")


def test_stream_queue_is_bounded_and_completion_never_blocks():
    manager = UnifiedExecManager(ExecutionConfig())
    stream = manager.register_stream("exec-2")
    entry = SimpleNamespace(
        execution_id="exec-2", tool_call_id="tool-1", call_id="call-1", process_id=1
    )

    for _ in range(stream.maxsize + 100):
        manager._emit_chunk(entry, "x")

    assert stream.qsize() == stream.maxsize
    manager._finish_stream(stream)
    drained = list(manager.iter_stream("exec-2", timeout=0.01))
    assert len(drained) < stream.maxsize
    manager.unregister_stream("exec-2")


def test_cancel_execution_is_scoped_to_execution_user_and_session(monkeypatch):
    manager = UnifiedExecManager(ExecutionConfig())
    matching = SimpleNamespace(execution_id="exec", user_id="u1", session_id="s1")
    other_user = SimpleNamespace(execution_id="exec", user_id="u2", session_id="s1")
    manager._processes = {1: matching, 2: other_user}
    finished = []
    monkeypatch.setattr(manager, "_finish_entry", finished.append)

    assert manager.cancel_execution("exec", "u1", "s1") == 1
    assert finished == [matching]


def test_cancel_process_is_scoped_to_process_owner(monkeypatch):
    manager = UnifiedExecManager(ExecutionConfig())
    matching = SimpleNamespace(execution_id="exec", user_id="u1", session_id="s1")
    manager._processes = {17: matching}
    finished = []
    monkeypatch.setattr(manager, "_finish_entry", finished.append)

    assert not manager.cancel_process(17, "u2", "s1")
    assert manager.cancel_process(17, "u1", "s1")
    assert finished == [matching]
