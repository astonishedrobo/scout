"""Build multimodal LangChain messages from local image paths."""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

from langchain_core.messages import HumanMessage
from ..chat_images import processed_data_url

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def image_paths(paths: list[str] | None) -> list[str]:
    return [str(Path(p).resolve()) for p in (paths or []) if Path(p).suffix.lower() in IMAGE_SUFFIXES]


def build_human_message(text: str, paths: list[str] | None = None) -> HumanMessage:
    images = image_paths(paths)
    if not images:
        return HumanMessage(content=text)
    content: list[dict] = [{"type": "text", "text": text or "Describe the attached image."}]
    for image in images:
        content.append({"type": "image_url", "image_url": {"url": processed_data_url(Path(image))}})
    return HumanMessage(content=content)
