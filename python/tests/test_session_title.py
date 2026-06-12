"""Tests for LLM session title generation helpers."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from scout.server.session_title import (
    DEFAULT_SESSION_TITLE,
    LEGACY_DEFAULT_TITLES,
    generate_session_title,
    normalize_title,
)


def test_normalize_title_strips_quotes_and_limits_words():
    assert normalize_title('"Hello World Example"') == "Hello World Example"
    assert normalize_title("one two three four five six seven eight nine") == DEFAULT_SESSION_TITLE
    assert normalize_title("Plot Random Histogram") == "Plot Random Histogram"


def test_normalize_title_truncates_long_output():
    title = normalize_title("Super Long Title That Keeps Going Forever And Ever")
    assert len(title.split()) <= 5


@pytest.mark.asyncio
async def test_generate_session_title_uses_litellm():
    mock_resp = AsyncMock()
    mock_resp.choices = [AsyncMock(message=AsyncMock(content="Random Histogram Plot"))]

    with patch("litellm.acompletion", AsyncMock(return_value=mock_resp)):
        title = await generate_session_title("plot a histogram", model="groq/test-model")

    assert title == "Random Histogram Plot"


@pytest.mark.asyncio
async def test_generate_session_title_can_use_assistant_response():
    mock_resp = AsyncMock()
    mock_resp.choices = [AsyncMock(message=AsyncMock(content="Image Text Extraction"))]
    completion = AsyncMock(return_value=mock_resp)

    with patch("litellm.acompletion", completion):
        title = await generate_session_title(
            "what does the image say?",
            model="openai/gpt-5",
            assistant_response="The image says EXPLORE YOUR DATA.",
        )

    assert title == "Image Text Extraction"
    request = completion.await_args.kwargs
    assert "EXPLORE YOUR DATA" in request["messages"][1]["content"]
    assert request["max_tokens"] == 128
    assert request["timeout"] == 15


@pytest.mark.asyncio
async def test_generate_session_title_falls_back_on_error():
    with patch("litellm.acompletion", AsyncMock(side_effect=RuntimeError("boom"))):
        title = await generate_session_title("hello", model="groq/test-model")
    assert title == DEFAULT_SESSION_TITLE


def test_append_message_leaves_default_title(tmp_path: Path):
    from scout.server.app import _set_session_title

    session_id = "abc-123"
    path = tmp_path / f"{session_id}.jsonl"
    header = {
        "type": "header",
        "sessionId": session_id,
        "projectDir": str(tmp_path),
        "createdAt": "2026-01-01T00:00:00Z",
        "title": DEFAULT_SESSION_TITLE,
    }
    path.write_text(json.dumps(header) + "\n", encoding="utf-8")

    entry = {"type": "user", "timestamp": "2026-01-01T00:00:01Z", "content": "hi"}
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")

    stored = json.loads(path.read_text(encoding="utf-8").split("\n")[0])
    assert stored["title"] == DEFAULT_SESSION_TITLE

    _set_session_title(path, "Friendly Greeting")
    stored = json.loads(path.read_text(encoding="utf-8").split("\n")[0])
    assert stored["title"] == "Friendly Greeting"
    assert "Friendly Greeting" not in LEGACY_DEFAULT_TITLES
