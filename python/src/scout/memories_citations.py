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
_ENTRY_LINE = re.compile(
    r"^([^:\n]+):(\d+)(?:-(\d+))?(?:\|note=\[(?P<note>[^\]]*)\])?",
    re.MULTILINE,
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
    if not match:
        return None
    body = match.group("body")
    entries: list[tuple[str, int, int | None, str]] = []
    for m in _ENTRY_LINE.finditer(body):
        path = m.group(1).strip()
        start = int(m.group(2))
        end = int(m.group(3)) if m.group(3) else None
        note = (m.group("note") or "").strip()
        entries.append((path, start, end, note))
    rollout_ids = list(dict.fromkeys(_UUID.findall(body)))
    return MemoryCitation(entries=entries, rollout_ids=rollout_ids)


def strip_citation_block(text: str) -> str:
    return _CITATION_BLOCK.sub("", text).rstrip()
