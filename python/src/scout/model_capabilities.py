"""Model capability resolution used for admission control."""

from __future__ import annotations

from typing import Literal

import litellm

VisionSupport = Literal["supported", "unsupported", "unverified"]


def model_vision_support(model: str, overrides: dict | None = None) -> VisionSupport:
    """Resolve vision support, failing closed when metadata is unavailable."""
    override = (overrides or {}).get(model)
    if isinstance(override, dict):
        override = override.get("vision")
    if override is True or override == "supported":
        return "supported"
    if override is False or override == "unsupported":
        return "unsupported"

    try:
        info = litellm.get_model_info(model=model)
        value = info.get("supports_vision")
        if value is True:
            return "supported"
        if value is False:
            return "unsupported"
    except Exception:
        pass
    return "unverified"
