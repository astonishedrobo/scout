"""LLM-generated chat session titles."""

from __future__ import annotations

import logging
import re

from pydantic import BaseModel, field_validator

logger = logging.getLogger(__name__)

DEFAULT_SESSION_TITLE = "New chat"
LEGACY_DEFAULT_TITLES = frozenset({"New session", "New chat"})

_TITLE_SYSTEM = (
    "Generate a concise chat title of 3 to 5 words summarizing the conversation. "
    "Return only the structured title field. The title must contain 3 to 5 words."
)


class SessionTitleOutput(BaseModel):
    """Structured title returned by the title-generation model."""

    title: str

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        title = normalize_title(value)
        if title in LEGACY_DEFAULT_TITLES:
            raise ValueError("title is empty or unusable")
        word_count = len(title.split())
        if not 3 <= word_count <= 5:
            raise ValueError("title must contain 3 to 5 words")
        return title


def fallback_title(
    message: str,
    *,
    assistant_response: str | None = None,
    has_images: bool = False,
    attachment_names: list[str] | None = None,
) -> str:
    """Build a useful title without making an LLM request."""
    source = message or assistant_response or ""
    cleaned = re.sub(r"[^\w\s-]", " ", source, flags=re.UNICODE)
    words = cleaned.split()
    if words:
        return " ".join(words[:5])[:40].strip()
    if has_images:
        return "Image Analysis"
    if attachment_names:
        return "File Analysis"
    return "Conversation"


def normalize_title(raw: str, *, fallback: str = DEFAULT_SESSION_TITLE) -> str:
    """Normalize LLM output into a short sidebar/header title."""
    cleaned = " ".join(raw.replace("\n", " ").split()).strip().strip("\"'`")
    cleaned = re.sub(r"[.!?:;]+$", "", cleaned).strip()
    if not cleaned:
        return fallback
    words = cleaned.split()
    if len(words) > 8:
        return fallback
    if len(words) > 5:
        cleaned = " ".join(words[:5])
    if len(cleaned) > 40:
        cleaned = cleaned[:40].rsplit(" ", 1)[0]
    return cleaned or fallback


async def generate_session_title(
    message: str,
    *,
    model: str,
    assistant_response: str | None = None,
    timeout_seconds: int = 60,
) -> str:
    """Generate a 3–5 word title from the opening conversation."""
    user_text = " ".join(message.split()).strip()
    response_text = " ".join((assistant_response or "").split()).strip()
    if not user_text and not response_text:
        return DEFAULT_SESSION_TITLE
    text = user_text or "User submitted content without a text prompt."
    if response_text:
        text += "\n\nAssistant response:\n" + response_text
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_litellm import ChatLiteLLM

        llm = ChatLiteLLM(
            model=model, temperature=0.2, request_timeout=timeout_seconds,
        )
        structured_llm = llm.with_structured_output(SessionTitleOutput)
        result = await structured_llm.ainvoke([
            SystemMessage(content=_TITLE_SYSTEM),
            HumanMessage(content=text[:2000]),
        ])
        if isinstance(result, SessionTitleOutput):
            return result.title
        return SessionTitleOutput.model_validate(result).title
    except Exception as exc:
        logger.warning(
            "Session title generation failed (model=%s, timeout=%ss): %s",
            model, timeout_seconds, exc, exc_info=True,
        )
        return DEFAULT_SESSION_TITLE
