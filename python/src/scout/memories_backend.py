"""Path-jailed read/write helpers for Codex-style memory folder."""

from __future__ import annotations

import re
from pathlib import Path

from .memories import add_memory_entry, ensure_memory_layout, list_memory_entries, resolve_memory_path


class MemoriesBackend:
    def __init__(
        self,
        *,
        personal_dir: Path | str | None = None,
        server_mode: bool = False,
        user_id: str = "default",
    ) -> None:
        self._personal = personal_dir
        self._server_mode = server_mode
        self._user_id = user_id

    @property
    def root(self) -> Path:
        return ensure_memory_layout(self._user_id, self._personal, self._server_mode)

    def search(self, query: str, *, max_results: int = 10) -> str:
        if not query.strip():
            return "(empty query)"
        pattern = re.compile(re.escape(query), re.IGNORECASE)
        hits: list[str] = []
        path = self.root / "MEMORY.md"
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
        for i, line in enumerate(lines, 1):
            if pattern.search(line):
                hits.append(f"MEMORY.md:{i}: {line.strip()[:200]}")
                if len(hits) >= max_results:
                    break
        if hits:
            return "\n".join(hits)

        entries = list_memory_entries(self._user_id, self._personal, self._server_mode)
        if entries:
            fallback = [
                f"MEMORY.md:{i + 1}: {entry[:200]}"
                for i, entry in enumerate(entries[:max_results])
            ]
            return "No exact matches. Current MEMORY.md entries:\n" + "\n".join(fallback)
        return f"(no memories for '{query}')"

    def read(self, path: str = "MEMORY.md", *, offset: int = 1, limit: int = 200) -> str:
        normalized = path.strip().strip("/") or "MEMORY.md"
        if normalized != "MEMORY.md":
            return f"[Invalid memory path: {path}]"
        target = resolve_memory_path(self.root, "MEMORY.md")
        if target is None:
            return "[Invalid memory path: MEMORY.md]"
        if not target.exists():
            return "[Not found: MEMORY.md]"
        try:
            lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            return f"[Read error: {exc}]"
        start = max(0, offset - 1)
        chunk = lines[start : start + limit]
        header = f"--- MEMORY.md (lines {offset}-{offset + len(chunk) - 1}) ---\n"
        return header + "\n".join(chunk)

    def list_dir(self, path: str = ".") -> str:
        entries = list_memory_entries(self._user_id, self._personal, self._server_mode)
        if entries:
            return "f MEMORY.md"
        return "(empty)"

    def add_memory(self, slug: str, content: str) -> str:
        content = content.strip()
        if not content:
            return "No memory written: empty content"
        add_memory_entry(content, self._user_id, self._personal, self._server_mode)
        return "Wrote memory to MEMORY.md"
