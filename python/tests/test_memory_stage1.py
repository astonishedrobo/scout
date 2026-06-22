import asyncio
import json
import os
import time
from pathlib import Path

import pytest

from scout.config import AppConfig, MemoriesConfig
from scout.memory_pipeline import stage1


def _write_session(path: Path, content: str = "remember this") -> None:
    path.write_text(
        "\n".join([
            json.dumps({"meta": True}),
            json.dumps({"role": "user", "content": content}),
        ]),
        encoding="utf-8",
    )
    old = time.time() - 7200
    os.utime(path, (old, old))


def test_filter_extracted_memory_drops_document_metadata_only():
    extracted = {
        "raw_memory": "\n".join([
            "- PDF title: Mapping India’s Climate Vulnerability",
            "- Authors: Abinash Mohanty and Shreya Wadhawan",
            "- File size/length: 40 pages, ~13,476 words",
        ]),
        "rollout_summary": "The user asked about a PDF.",
        "rollout_slug": "pdf-summary",
    }

    assert stage1._filter_extracted_memory(extracted) == {
        "raw_memory": "",
        "rollout_summary": "",
        "rollout_slug": "",
    }


@pytest.mark.asyncio
async def test_fallback_extract_keeps_only_explicit_memory_signals(monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "litellm", None)
    transcript = "\n".join([
        "user: summarize this PDF",
        "assistant: The PDF title is Example.",
        "user: remember that I prefer concise answers",
    ])

    extracted = await stage1._llm_extract(transcript, AppConfig())

    assert "summarize this PDF" not in extracted["raw_memory"]
    assert "prefer concise answers" in extracted["raw_memory"]


@pytest.mark.asyncio
async def test_batch_excludes_trigger_and_bounds_model_calls(tmp_path: Path, monkeypatch):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    for name in ["trigger", "a", "b", "c"]:
        _write_session(sessions / f"{name}.jsonl")

    calls: list[str] = []

    async def fake_extract(transcript, config):
        calls.append(transcript)
        return {
            "raw_memory": "- durable",
            "rollout_summary": "summary",
            "rollout_slug": "slug",
        }

    monkeypatch.setattr(stage1, "_llm_extract", fake_extract)
    config = MemoriesConfig(stage1_max_jobs_per_startup=2, stage1_scan_limit=32)
    count = await stage1.run_stage1_batch(
        sessions,
        personal_dir=tmp_path,
        server_mode=True,
        memories_config=config,
        app_config=AppConfig(),
        exclude_thread_id="trigger",
    )

    assert count == 2
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_successful_no_output_is_not_processed_again(tmp_path: Path, monkeypatch):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    _write_session(sessions / "quiet.jsonl")
    calls = 0

    async def fake_extract(transcript, config):
        nonlocal calls
        calls += 1
        return {"raw_memory": "", "rollout_summary": "", "rollout_slug": ""}

    monkeypatch.setattr(stage1, "_llm_extract", fake_extract)
    config = MemoriesConfig()
    for _ in range(2):
        await stage1.run_stage1_batch(
            sessions,
            personal_dir=tmp_path,
            server_mode=True,
            memories_config=config,
            app_config=AppConfig(),
        )

    assert calls == 1


@pytest.mark.asyncio
async def test_batch_respects_concurrency_limit(tmp_path: Path, monkeypatch):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    for i in range(5):
        _write_session(sessions / f"{i}.jsonl")
    active = 0
    peak = 0

    async def fake_extract(transcript, config):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return {
            "raw_memory": "- durable",
            "rollout_summary": "summary",
            "rollout_slug": "slug",
        }

    monkeypatch.setattr(stage1, "_llm_extract", fake_extract)
    await stage1.run_stage1_batch(
        sessions,
        personal_dir=tmp_path,
        server_mode=True,
        memories_config=MemoriesConfig(
            stage1_max_jobs_per_startup=5,
            stage1_concurrency=2,
        ),
        app_config=AppConfig(),
    )

    assert peak == 2
