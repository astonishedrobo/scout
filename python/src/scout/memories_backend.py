"""Path-jailed read/write helpers for Codex-style memory folder."""

from __future__ import annotations

import re
import time
from pathlib import Path

from .memories import add_memory_entry, ensure_memory_layout, memories_root, resolve_memory_path


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
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.suffix not in {".md", ".txt", ".jsonl"}:
                continue
            if "extensions" in path.parts and "ad_hoc" not in path.parts:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    rel = path.relative_to(self.root)
                    hits.append(f"{rel}:{i}: {line.strip()[:200]}")
                    if len(hits) >= max_results:
                        break
            if len(hits) >= max_results:
                break
        return "\n".join(hits) if hits else f"(no matches for '{query}')"

    def read(self, path: str, *, offset: int = 1, limit: int = 200) -> str:
        target = resolve_memory_path(self.root, path)
        if target is None:
            return f"[Invalid memory path: {path}]"
        if not target.exists():
            return f"[Not found: {path}]"
        try:
            lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            return f"[Read error: {exc}]"
        start = max(0, offset - 1)
        chunk = lines[start : start + limit]
        header = f"--- {path} (lines {offset}-{offset + len(chunk) - 1}) ---\n"
        return header + "\n".join(chunk)

    def list_dir(self, path: str = ".") -> str:
        target = resolve_memory_path(self.root, path) if path != "." else self.root
        if target is None or not target.is_dir():
            return f"[Not a directory: {path}]"
        entries = sorted(target.iterdir())
        lines: list[str] = []
        for e in entries[:100]:
            prefix = "d " if e.is_dir() else "f "
            try:
                rel = e.relative_to(self.root)
            except ValueError:
                rel = e.name
            lines.append(f"{prefix}{rel}")
        return "\n".join(lines) or "(empty)"

    def add_ad_hoc_note(self, slug: str, content: str) -> str:
        content = content.strip()
        slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", slug.strip())[:40] or "note"
        ts = time.strftime("%Y-%m-%dT%H-%M-%S")
        notes_dir = self.root / "extensions" / "ad_hoc" / "notes"
        notes_dir.mkdir(parents=True, exist_ok=True)
        path = notes_dir / f"{ts}-{slug}.md"
        path.write_text(content + "\n", encoding="utf-8")
        add_memory_entry(content, self._user_id, self._personal, self._server_mode)
        rel = path.relative_to(self.root)
        return f"Wrote memory note to MEMORY.md and ad-hoc note: {rel}"
