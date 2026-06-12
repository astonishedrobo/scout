"""Secret redaction before persisting memory pipeline outputs."""

from __future__ import annotations

import re

_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*\S+"),
    re.compile(r"(?i)Bearer\s+[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)sk-[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)AKIA[0-9A-Z]{16}"),
    re.compile(r"(?i)xox[baprs]-[A-Za-z0-9\-]+"),
    re.compile(r"(?i)\.env(?:\.[a-z]+)?\b"),
]

_REDACTED = "[REDACTED]"


def redact_secrets(text: str) -> str:
    out = text
    for pat in _PATTERNS:
        out = pat.sub(_REDACTED, out)
    return out
