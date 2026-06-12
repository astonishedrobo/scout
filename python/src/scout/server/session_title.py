"""LLM-generated chat session titles."""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

DEFAULT_SESSION_TITLE = "New chat"
LEGACY_DEFAULT_TITLES = frozenset({"New session", "New chat"})

_TITLE_SYSTEM = (
    "Generate a concise chat title of 3 to 5 words summarizing the conversation. "
    "Reply with title text only — no quotes, punctuation, or explanation."
)


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
) -> str:
    """Generate a 3–5 word title from the opening conversation."""
    text = " ".join(message.split()).strip()
    if not text:
        return DEFAULT_SESSION_TITLE
    if assistant_response:
        text += "\n\nAssistant response:\n" + " ".join(assistant_response.split()).strip()
    try:
        import litellm

        resp = await litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _TITLE_SYSTEM},
                {"role": "user", "content": text[:2000]},
            ],
            max_tokens=128,
            temperature=0.2,
            timeout=15,
        )
        raw = (resp.choices[0].message.content or "").strip()
        title = normalize_title(raw)
        if title in LEGACY_DEFAULT_TITLES:
            return DEFAULT_SESSION_TITLE
        return title
    except Exception:
        logger.warning("Session title generation failed", exc_info=True)
        return DEFAULT_SESSION_TITLE
