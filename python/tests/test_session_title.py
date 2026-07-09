"""Tests for LLM session title generation helpers."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scout.server.session_title import (
    DEFAULT_SESSION_TITLE,
    LEGACY_DEFAULT_TITLES,
    generate_session_title,
    fallback_title,
    normalize_title,
    SessionTitleOutput,
)


def test_normalize_title_strips_quotes_and_limits_words():
    assert normalize_title('"Hello World Example"') == "Hello World Example"
    assert normalize_title("one two three four five six seven eight nine") == DEFAULT_SESSION_TITLE
    assert normalize_title("Plot Random Histogram") == "Plot Random Histogram"


def test_normalize_title_truncates_long_output():
    title = normalize_title("Super Long Title That Keeps Going Forever And Ever")
    assert len(title.split()) <= 5


def test_structured_title_requires_three_to_five_words():
    assert SessionTitleOutput(title="Quarterly Revenue Growth").title == "Quarterly Revenue Growth"
    with pytest.raises(ValueError, match="3 to 5"):
        SessionTitleOutput(title="Revenue")


def test_fallback_title_uses_first_meaningful_words():
    assert fallback_title("generate some random numbers and make a histogram") == "generate some random numbers and"
    assert fallback_title("", has_images=True) == "Image Analysis"
    assert fallback_title("", attachment_names=["report.csv"]) == "File Analysis"


@pytest.mark.asyncio
async def test_generate_session_title_uses_litellm():
    structured = MagicMock()
    structured.ainvoke = AsyncMock(return_value=SessionTitleOutput(title="Random Histogram Plot"))
    llm = MagicMock()
    llm.with_structured_output.return_value = structured

    with patch("langchain_litellm.ChatLiteLLM", return_value=llm):
        title = await generate_session_title("plot a histogram", model="groq/test-model")

    assert title == "Random Histogram Plot"
    llm.with_structured_output.assert_called_once_with(SessionTitleOutput)


@pytest.mark.asyncio
async def test_generate_session_title_can_use_assistant_response():
    structured = MagicMock()
    structured.ainvoke = AsyncMock(return_value=SessionTitleOutput(title="Image Text Extraction"))
    llm = MagicMock()
    llm.with_structured_output.return_value = structured

    with patch("langchain_litellm.ChatLiteLLM", return_value=llm) as chat_model:
        title = await generate_session_title(
            "what does the image say?",
            model="openai/gpt-5",
            assistant_response="The image says EXPLORE YOUR DATA.",
        )

    assert title == "Image Text Extraction"
    request = structured.ainvoke.await_args.args[0]
    assert "EXPLORE YOUR DATA" in request[1].content
    assert chat_model.call_args.kwargs["request_timeout"] == 60
    assert "max_tokens" not in chat_model.call_args.kwargs


@pytest.mark.asyncio
async def test_generate_session_title_uses_configured_timeout():
    structured = MagicMock()
    structured.ainvoke = AsyncMock(return_value=SessionTitleOutput(title="Slow Model Title"))
    llm = MagicMock()
    llm.with_structured_output.return_value = structured
    with patch("langchain_litellm.ChatLiteLLM", return_value=llm) as chat_model:
        await generate_session_title("hello", model="openai/test", timeout_seconds=90)
    assert chat_model.call_args.kwargs["request_timeout"] == 90


@pytest.mark.asyncio
async def test_generate_session_title_passes_client_kwargs():
    structured = MagicMock()
    structured.ainvoke = AsyncMock(return_value=SessionTitleOutput(title="Local Model Title"))
    llm = MagicMock()
    llm.with_structured_output.return_value = structured
    with patch("langchain_litellm.ChatLiteLLM", return_value=llm) as chat_model:
        await generate_session_title(
            "hello",
            model="hosted_vllm/Qwen/Qwen3-0.6B",
            client_kwargs={
                "api_key": "local-vllm",
                "api_base": "http://vllm:8000/v1",
            },
        )

    assert chat_model.call_args.kwargs["api_key"] == "local-vllm"
    assert chat_model.call_args.kwargs["api_base"] == "http://vllm:8000/v1"


@pytest.mark.asyncio
async def test_generate_session_title_falls_back_on_error():
    with patch("langchain_litellm.ChatLiteLLM", side_effect=RuntimeError("boom")):
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


@pytest.mark.asyncio
async def test_title_job_uses_fallback(tmp_path: Path):
    from scout.server.app import _run_title_job

    path = tmp_path / "session.jsonl"
    path.write_text(
        json.dumps({"type": "header", "sessionId": "s", "title": DEFAULT_SESSION_TITLE}) + "\n"
        + json.dumps({"type": "user", "content": "create a useful histogram please"}) + "\n",
        encoding="utf-8",
    )

    with patch(
        "scout.server.app.generate_session_title",
        AsyncMock(return_value=DEFAULT_SESSION_TITLE),
    ):
        await _run_title_job(path, "openai/test", max_attempts=2)

    stored = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert stored["title"] == "create a useful histogram please"
    assert stored["titleGenerationStatus"] == "completed"
    assert stored["titleGenerationAttempts"] == 2


@pytest.mark.asyncio
async def test_title_generation_does_not_overwrite_existing_title(tmp_path: Path):
    from scout.server.app import _run_title_job

    path = tmp_path / "session.jsonl"
    path.write_text(json.dumps({"type": "header", "sessionId": "s", "title": "Existing Title"}) + "\n", encoding="utf-8")
    completion = AsyncMock(return_value="Replacement Title")

    with patch("scout.server.app.generate_session_title", completion):
        await _run_title_job(path, "openai/test")

    assert completion.await_count == 0
    stored = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert stored["title"] == "Existing Title"


@pytest.mark.asyncio
async def test_image_only_title_uses_assistant_response(tmp_path: Path):
    from scout.server.app import _run_title_job

    path = tmp_path / "session.jsonl"
    path.write_text(
        json.dumps({"type": "header", "sessionId": "s", "title": DEFAULT_SESSION_TITLE}) + "\n"
        + json.dumps({"type": "user", "content": "", "chat_images": [{"id": "image-1"}]}) + "\n"
        + json.dumps({"type": "assistant", "content": "The image shows quarterly revenue growth."}) + "\n",
        encoding="utf-8",
    )
    structured = MagicMock()
    structured.ainvoke = AsyncMock(return_value=SessionTitleOutput(title="Quarterly Revenue Growth"))
    llm = MagicMock()
    llm.with_structured_output.return_value = structured
    with patch("langchain_litellm.ChatLiteLLM", return_value=llm):
        await _run_title_job(path, "openai/test")

    stored = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert stored["title"] == "Quarterly Revenue Growth"
