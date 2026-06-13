"""Tests for memory SQLite store."""

from pathlib import Path

from scout.memory_store import JOB_KIND_STAGE1, MemoryStore, Stage1Output


def test_upsert_and_record_usage(tmp_path: Path):
    store = MemoryStore(tmp_path / "memory.db")
    store.upsert_stage1(Stage1Output(
        thread_id="sess-1",
        session_path="/tmp/sess-1.jsonl",
        raw_memory="- prefers pytest",
        rollout_summary="User likes pytest.",
        rollout_slug="pytest-pref",
        source_updated_at=1000,
        generated_at=1001,
    ))
    assert store.get_stage1("sess-1") is not None
    assert store.record_usage(["sess-1"]) == 1
    row = store.get_stage1("sess-1")
    assert row and row.usage_count == 1


def test_job_claim_and_finish(tmp_path: Path):
    store = MemoryStore(tmp_path / "memory.db")
    token = store.try_claim_job(JOB_KIND_STAGE1, "job-a")
    assert token is not None
    assert store.try_claim_job(JOB_KIND_STAGE1, "job-a") is None
    store.finish_job(JOB_KIND_STAGE1, "job-a", token, success=True)
    token2 = store.try_claim_job(JOB_KIND_STAGE1, "job-a")
    assert token2 is not None


def test_filter_candidates_skips_unchanged_and_does_not_starve_new(tmp_path: Path):
    store = MemoryStore(tmp_path / "memory.db")
    candidates = []
    for i in range(40):
        thread_id = f"old-{i}"
        candidates.append((thread_id, 100 + i))
        token = store.try_claim_job(JOB_KIND_STAGE1, thread_id)
        assert token
        store.finish_job(JOB_KIND_STAGE1, thread_id, token, success=True, watermark=100 + i)
    candidates.append(("new", 1000))

    assert store.filter_stage1_candidates(candidates, limit=4) == ["new"]


def test_filter_candidates_respects_retry_backoff(tmp_path: Path):
    store = MemoryStore(tmp_path / "memory.db")
    token = store.try_claim_job(JOB_KIND_STAGE1, "failed")
    assert token
    store.finish_job(
        JOB_KIND_STAGE1,
        "failed",
        token,
        success=False,
        retry_backoff_seconds=3600,
    )

    assert store.filter_stage1_candidates([("failed", 100)], limit=4) == []
