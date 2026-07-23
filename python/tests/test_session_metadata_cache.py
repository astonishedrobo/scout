import json
from concurrent.futures import ThreadPoolExecutor

from scout.server.app import (
    _parse_session_file,
    _parse_session_meta,
    _session_meta_cache,
    _append_session_entry,
    _update_session_header,
)


def _write_session(path, *, extra_message=False):
    entries = [
        {"type": "header", "sessionId": "s1", "title": "Cached", "createdAt": "2026-01-01T00:00:00Z", "model": "test/model"},
        {"type": "user", "content": "hello", "timestamp": "2026-01-01T00:01:00Z"},
        {"type": "assistant", "content": "hi", "timestamp": "2026-01-01T00:02:00Z"},
    ]
    if extra_message:
        entries.append({"type": "user", "content": "again", "timestamp": "2026-01-01T00:03:00Z"})
    path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")


def test_lightweight_session_metadata_matches_full_parser(tmp_path):
    path = tmp_path / "s1.jsonl"
    _write_session(path)
    _session_meta_cache.clear()

    assert _parse_session_meta(path) == _parse_session_file(path)["meta"]


def test_session_metadata_cache_invalidates_when_file_changes(tmp_path):
    path = tmp_path / "s1.jsonl"
    _write_session(path)
    _session_meta_cache.clear()
    first = _parse_session_meta(path)

    _write_session(path, extra_message=True)
    second = _parse_session_meta(path)

    assert first["messageCount"] == 2
    assert second["messageCount"] == 3
    assert second["updatedAt"] == "2026-01-01T00:03:00Z"


def test_session_metadata_result_cannot_mutate_cached_value(tmp_path):
    path = tmp_path / "s1.jsonl"
    _write_session(path)
    _session_meta_cache.clear()
    first = _parse_session_meta(path)
    first["title"] = "mutated"

    assert _parse_session_meta(path)["title"] == "Cached"


def test_task_lifecycle_rows_survive_session_reload(tmp_path):
    path = tmp_path / "s1.jsonl"
    _write_session(path)
    _append_session_entry(path, {
        "type": "task",
        "timestamp": "2026-01-01T00:02:05Z",
        "task": {
            "task_id": "sa-1",
            "task_type": "agent",
            "title": "Inspect authentication",
            "status": "completed",
            "created_at": 1.0,
            "finished_at": 12.0,
        },
    })

    messages = _parse_session_file(path)["messages"]
    assert messages[-1]["role"] == "system"
    assert messages[-1]["task"]["title"] == "Inspect authentication"
    assert messages[-1]["task"]["status"] == "completed"


def test_header_updates_cannot_lose_concurrent_message_appends(tmp_path):
    path = tmp_path / "s1.jsonl"
    _write_session(path)

    def append(index: int):
        _append_session_entry(path, {
            "type": "user", "content": f"message-{index}", "timestamp": str(index)
        })

    def update(index: int):
        _update_session_header(path, title=f"title-{index}")

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(append, index) for index in range(100)]
        futures.extend(pool.submit(update, index) for index in range(25))
        for future in futures:
            future.result()

    parsed = _parse_session_file(path)
    appended = {
        message["content"] for message in parsed["messages"]
        if message["content"].startswith("message-")
    }
    assert appended == {f"message-{index}" for index in range(100)}
