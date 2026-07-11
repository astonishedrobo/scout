"""Parse scout-mem-citation blocks and record memory usage."""

from __future__ import annotations

import re
from dataclasses import dataclass

_CITATION_BLOCK = re.compile(
    r"<scout-mem-citation>\s*"
    r"(?P<body>.*?)"
    r"</scout-mem-citation>",
    re.DOTALL | re.IGNORECASE,
)
# Models sometimes emit only the inner tags, or drop the outer wrapper entirely.
_CITATION_ENTRIES_BLOCK = re.compile(
    r"<\s*citation_entries\s*>.*?<\s*/\s*citation_entries\s*>",
    re.DOTALL | re.IGNORECASE,
)
_ROLLOUT_IDS_BLOCK = re.compile(
    r"<\s*rollout_ids\s*>.*?<\s*/\s*rollout_ids\s*>",
    re.DOTALL | re.IGNORECASE,
)
# Incomplete / one-line harness markup that never closed properly.
_CITATION_FRAGMENT = re.compile(
    r"<\s*/?\s*(?:scout-mem-citation|citation_entries|rollout_ids)\b[^>]*>",
    re.IGNORECASE,
)
_ENTRY_LINE = re.compile(
    r"(?:^|\n)\s*([^:\n]+):(\d+)(?:-(\d+))?(?:\|note=\[(?P<note>[^\]]*)\])?",
)
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


@dataclass
class MemoryCitation:
    entries: list[tuple[str, int, int | None, str]]
    rollout_ids: list[str]


def parse_memory_citation(text: str) -> MemoryCitation | None:
    match = _CITATION_BLOCK.search(text)
    body = match.group("body") if match else text
    # Also accept orphan citation_entries fragments.
    entries_match = _CITATION_ENTRIES_BLOCK.search(text)
    if not match and not entries_match:
        return None
    if entries_match and not match:
        body = entries_match.group(0)
    entries: list[tuple[str, int, int | None, str]] = []
    for m in _ENTRY_LINE.finditer(body):
        path = m.group(1).strip().lstrip("<").strip()
        if path.lower() in {"citation_entries", "rollout_ids", "scout-mem-citation"}:
            continue
        start = int(m.group(2))
        end = int(m.group(3)) if m.group(3) else None
        note = (m.group("note") or "").strip()
        entries.append((path, start, end, note))
    rollout_ids = list(dict.fromkeys(_UUID.findall(body if match else text)))
    if not entries and not rollout_ids:
        return None
    return MemoryCitation(entries=entries, rollout_ids=rollout_ids)


def strip_citation_block(text: str) -> str:
    """Remove memory-citation harness markup from user-facing assistant text.

    Handles the full scout-mem-citation wrapper and partial fragments models
    sometimes emit (e.g. only ``<citation_entries>...</citation_entries>``).
    """
    cleaned = _CITATION_BLOCK.sub("", text)
    cleaned = _CITATION_ENTRIES_BLOCK.sub("", cleaned)
    cleaned = _ROLLOUT_IDS_BLOCK.sub("", cleaned)
    cleaned = _CITATION_FRAGMENT.sub("", cleaned)
    # Collapse leftover blank lines introduced by stripping.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.rstrip()