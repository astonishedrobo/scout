"""LangGraph tool definitions for the Scout data-research agent.

Each tool is a plain function decorated with ``@tool``.  They close over
shared resources (session, retriever) which are injected at graph-build
time via :func:`make_tools`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

from langchain_core.tools import tool

from .file_guard import is_path_denied, is_name_denied, WorkspaceGuard

if TYPE_CHECKING:
    from ..execution.service import ExecutionService
    from ..retriever import BM25Retriever
    from .session import PersistentPythonSession


# ── Factory ──────────────────────────────────────────────────────────────


def make_tools(
    retriever: "BM25Retriever",
    data_dir: str | Path,
    disable_write_tools: bool = False,
    guard: "WorkspaceGuard | None" = None,
    execution_service: "ExecutionService | None" = None,
    session: "PersistentPythonSession | None" = None,
    allowed_tools: frozenset[str] | None = None,
    *,
    personal_dir: str | Path | None = None,
    server_mode: bool = False,
    user_id: str = "default",
    use_memories: bool = True,
    allow_request_permissions: bool = True,
    request_permissions_fn=None,
) -> list:
    """Create tool functions, binding resources via closures.

    ``session`` is accepted for call-site compatibility but unused
    (persistent ``run_python`` / ``run_code`` tools were removed).
    """

    data_dir = str(Path(data_dir).resolve())
    _fallback_exts = {".txt", ".md", ".json", ".csv"}

    def _read_denied(p: Path) -> bool:
        return guard.is_read_denied(p) if guard else is_path_denied(p)

    def _write_denied(p: Path) -> bool:
        return guard.is_write_denied(p) if guard else is_path_denied(p)

    def _resolve_workspace_path(path: str) -> Path:
        """Map canonical agent paths into this tool's workspace roots."""
        p = Path(path)
        def _shared_path(parts: tuple[str, ...]) -> Path | None:
            shared_dir = getattr(guard, "_shared", None)
            if shared_dir is None:
                return None
            return Path(shared_dir) / (Path(*parts) if parts else Path("."))

        if p.is_absolute():
            if p.parts[:2] == ("/", "workspace"):
                relative = p.parts[2:]
                return Path(data_dir) / (Path(*relative) if relative else Path("."))
            if p.parts[:2] == ("/", "shared"):
                shared = _shared_path(p.parts[2:])
                if shared is not None:
                    return shared
            return p

        if p.parts[:1] == ("shared",):
            shared = _shared_path(p.parts[1:])
            if shared is not None:
                return shared
        return Path(data_dir) / p

    def _fallback_search_documents(
        query: str,
        top_k: int,
        *,
        path_filter: str = "",
    ) -> str:
        from ..retriever import source_file_matches

        root = Path(data_dir)
        q = query.strip().lower()
        if not q:
            return "(empty query)"

        hits: list[tuple[int, str, str]] = []
        for fpath in root.rglob("*"):
            if not fpath.is_file():
                continue
            if fpath.suffix.lower() not in _fallback_exts:
                continue
            if is_name_denied(fpath.name) or _read_denied(fpath):
                continue
            if ".scout-executions" in fpath.parts or ".scout-cache" in fpath.parts:
                continue
            if path_filter:
                try:
                    rel = str(fpath.relative_to(root))
                except Exception:
                    rel = str(fpath)
                if not (
                    source_file_matches(rel, path_filter)
                    or source_file_matches(str(fpath), path_filter)
                    or source_file_matches(fpath.name, path_filter)
                ):
                    continue
            try:
                if fpath.stat().st_size > 100_000_000:
                    continue
                text = fpath.read_text(errors="replace")
            except Exception:
                continue
            if not text:
                continue

            lower = text.lower()
            if q not in lower:
                continue

            idx = lower.find(q)
            score = max(1, lower.count(q))
            start = max(0, idx - 120)
            end = min(len(text), idx + 220)
            snippet = re.sub(r"\s+", " ", text[start:end]).strip()
            if start > 0:
                snippet = "..." + snippet
            if end < len(text):
                snippet = snippet + "..."

            try:
                src = str(fpath.relative_to(root))
            except Exception:
                src = str(fpath)
            hits.append((score, src, snippet))

        if not hits:
            scope = f" in '{path_filter}'" if path_filter else ""
            return f"(no matching documents found{scope})"

        hits.sort(key=lambda x: (-x[0], x[1]))
        parts = [
            f"[{i}] {src} (fallback score: {score})\n{snippet}"
            for i, (score, src, snippet) in enumerate(hits[:top_k], 1)
        ]
        return "\n\n---\n\n".join(parts)

    # ── Execution tools ──────────────────────────────────────────────

    @tool
    async def exec_command(
        cmd: str,
        workdir: str = "",
        yield_time_ms: int = 10_000,
        description: str = "",
    ) -> str:
        """Run a command in a PTY, returning output or a session ID for ongoing interaction.

        Short commands finish within yield_time_ms and return exit code.
        Long-running commands return a session ID — poll with write_stdin(session_id, "").
        File writes are staged for approval. Network access requires approval.
        Commands run from /workspace by default. Use bare relative paths such
        as "script.py" for personal workspace files, or /shared/... for shared
        files. Do not use server/host paths such as /app/workspace or
        /srv/scout-source.
        """
        if not execution_service:
            return "[SANDBOX UNAVAILABLE] Shell execution requires an active execution sandbox."
        result = await execution_service.exec_command(
            cmd,
            workdir=workdir,
            yield_time_ms=yield_time_ms,
            description=description,
        )
        return result.text

    @tool
    async def write_stdin(
        session_id: int,
        chars: str = "",
        yield_time_ms: int = 10_000,
    ) -> str:
        """Write characters to an existing unified exec session and return recent output.

        Use empty chars to poll a running process. Session ID comes from exec_command.
        """
        if not execution_service:
            return "[SANDBOX UNAVAILABLE] Shell execution requires an active execution sandbox."
        result = await execution_service.write_stdin(
            session_id,
            chars,
            yield_time_ms=yield_time_ms,
        )
        return result.text

    @tool
    async def run_shell(command: str, description: str = "") -> str:
        """Legacy one-shot shell (used when unified_shell is disabled)."""
        if not execution_service:
            return "[SANDBOX UNAVAILABLE] Shell execution requires an active execution sandbox."
        result = await execution_service.run_shell(command, description)
        return result.text

    @tool
    async def run_node(code: str, description: str = "") -> str:
        """Execute JavaScript/Node.js code in an isolated sandbox."""
        if not execution_service:
            return "[SANDBOX UNAVAILABLE] Node execution requires an active execution sandbox."
        result = await execution_service.run_node(code, description)
        return result.text

    # ── 2. read_file ─────────────────────────────────────────────────

    @tool
    def read_file(path: str, max_lines: int = 200) -> str:
        """Read a file and return its first *max_lines* lines as text."""
        p = _resolve_workspace_path(path)
        if _read_denied(p):
            return f"[Access denied: {p.name} is a protected file]"
        if not p.exists():
            parent = p.parent
            if parent.is_dir():
                siblings = sorted(
                    f.name for f in parent.iterdir()
                    if f.is_file() and not is_name_denied(f.name)
                    and ".scout-executions" not in f.parts
                )
                listing = "\n  ".join(siblings[:30]) or "(empty)"
                try:
                    parent_label = parent.relative_to(data_dir)
                except ValueError:
                    parent_label = parent
                return (
                    f"[File not found: {p.name}]\n"
                    f"Files in {parent_label}:\n  {listing}"
                )
            return f"[File not found: {p}]"
        try:
            lines = p.read_text(errors="replace").splitlines()[:max_lines]
            result = "\n".join(lines)
            if len(lines) == max_lines:
                result += f"\n\n… [showing first {max_lines} lines]"
            return result
        except Exception as exc:
            return f"[Error reading {p}: {exc}]"

    @tool
    def list_files(directory: str = ".") -> str:
        """List files and sub-directories in a directory."""
        p = _resolve_workspace_path(directory)
        if _read_denied(p):
            return f"[Access denied: {p.name} is a protected directory]"
        if not p.is_dir():
            return f"[Not a directory: {p}]"
        entries = sorted(p.iterdir())
        lines: list[str] = []
        shown = 0
        for e in entries:
            if is_name_denied(e.name):
                continue
            if e.name in {".scout-cache", ".scout-executions"}:
                continue
            if e.is_dir() and e.name.lower() in {".ssh", ".gnupg", ".aws", ".docker", ".scout", ".git"}:
                continue
            prefix = "📁 " if e.is_dir() else "   "
            lines.append(f"{prefix}{e.name}")
            shown += 1
            if shown >= 50:
                break
        result = "\n".join(lines) or "(empty)"
        if len(entries) > shown:
            result += "\n… (more entries)"
        return result

    @tool
    def search_documents(query: str, path: str = "", top_k: int = 5) -> str:
        """Search indexed workspace documents (text, Markdown, JSON, CSV, PDF).

        Uses the shared BM25 index over the workspace. Pass *query* with keywords
        to match. Optionally pass *path* (workspace path, relative path, or
        basename) to search within a single file only — including PDFs. There is
        no separate PDF reader; use this tool for all document types.
        """
        source_file: str | None = None
        if path and path.strip():
            p = _resolve_workspace_path(path.strip())
            if _read_denied(p):
                return f"[Access denied: {p.name} is a protected file]"
            # Prefer resolved path so absolute/relative forms match the index.
            source_file = str(p) if p.exists() else path.strip()

        chunks = retriever.search(query, top_k=top_k, source_file=source_file)
        if not chunks:
            return _fallback_search_documents(
                query, top_k=top_k, path_filter=source_file or path.strip()
            )

        parts: list[str] = []
        for i, c in enumerate(chunks, 1):
            header = f"[{i}] {c.source_file} (score: {c.score:.2f})"
            if c.source_type == "json" and c.record_index is not None:
                header += f"  [record_{c.record_index}]"
                if c.metadata:
                    meta_str = " | ".join(
                        f"{k}: {v}" for k, v in c.metadata.items()
                    )
                    header += f"\n    Metadata: {meta_str}"
            parts.append(f"{header}\n{c.text}")

        return "\n\n---\n\n".join(parts)

    @tool
    def think(content: str = "", title: str = "", reflection: str = "") -> str:
        """Label the next tool phase and optionally narrate it in main prose.

        *title*: short phase name for the tool-activity card (e.g. "Plan demo").
        *content*: user-visible prose shown in the main transcript (not private).
        *reflection*: legacy alias for content.
        After calling this, run the related tools for that phase.
        """
        return "[Thought recorded — continue with your plan.]"

    @tool
    def ask_user_choice(
        question: str,
        header: str = "Question",
        options: list[dict[str, str]] | None = None,
    ) -> str:
        """Ask the user a structured question, optionally with multiple-choice options.

        Use this for explicit interactive flows (quizzes, MCQs, pick-one
        decisions) and for genuinely blocking choices. Provide options as
        [{"label": "...", "description": "..."}] when the answer can be
        expressed as a small multiple-choice decision. Omit options only when
        free-form input is required.

        Option rules:
        - `label` is the literal answer text itself (e.g. "Paris"), NEVER a
          letter or index like "A", "Option B", or "1." — the UI adds its own
          numbering.
        - `description` is optional extra context; omit it entirely when it
          would just repeat the label. For quiz questions, plain labels with
          no descriptions are usually correct.
        - The user's reply arrives as the chosen label text verbatim (or their
          own free-form text), so refer to answers by label, not by letter.
        """
        return question

    @tool
    def apply_patch(patch: str, description: str = "") -> str:
        """Apply a unified diff patch to one or more files. Requires user approval."""
        return "Patch application is handled by the approval layer."

    @tool
    def write_file(path: str, content: str, description: str = "") -> str:
        """Write text content to a file. Requires user approval."""
        from ..atomic_io import atomic_write_text
        p = _resolve_workspace_path(path)
        if _write_denied(p):
            return f"[Access denied: cannot write to {p}]"
        atomic_write_text(p, content, encoding="utf-8")
        return f"Wrote {len(content)} characters to {p}"

    @tool
    def write_binary_artifact(path: str, content_base64: str, mime_type: str, description: str = "") -> str:
        """Save base64-encoded in-memory output such as a PNG or SVG."""
        return "Binary artifact write is handled by the approval layer."

    @tool
    def present_files(filepaths: list[str]) -> str:
        """Queue existing workspace files for the user as openable UI cards.

        Use when the user should view files that you are not editing right now.
        Creates/edits already surface cards automatically — do not re-present those
        unless the user asks to see them again. Does not modify files.
        """
        # Actual queue + artifact emit is handled in the tool node so the UI
        # receives unique presentable descriptors at the end of the turn.
        return "Presentation is handled by the presentation layer."

    from ..memories_backend import MemoriesBackend
    from ..skills_registry import list_skills, read_skill

    _mem_backend = MemoriesBackend(
        personal_dir=personal_dir, server_mode=server_mode, user_id=user_id,
    )

    @tool
    def memory_search(query: str) -> str:
        """Search MEMORY.md and rollout summaries under the memory folder."""
        return _mem_backend.search(query)

    @tool
    def memory_read(path: str, offset: int = 1, limit: int = 200) -> str:
        """Read a file under the memory folder by relative path."""
        return _mem_backend.read(path, offset=offset, limit=limit)

    @tool
    def memory_list(path: str = ".") -> str:
        """List a directory under the memory folder."""
        return _mem_backend.list_dir(path)

    @tool
    def memory_add_note(slug: str, content: str) -> str:
        """Add a memory to MEMORY.md (only when user explicitly requested)."""
        return _mem_backend.add_memory(slug, content)

    @tool
    def skill_list() -> str:
        """List available skills (name, description, path)."""
        return list_skills(data_dir, personal_dir=personal_dir)

    @tool
    def skill_read(path: str) -> str:
        """Load full SKILL.md body for a skill path from skill_list."""
        return read_skill(path, data_dir, personal_dir=personal_dir)

    @tool
    async def request_permissions(reason: str, network_domains: str = "") -> str:
        """Request elevated permissions (network, shared write). Requires user approval."""
        if not allow_request_permissions or request_permissions_fn is None:
            return "[REQUEST DENIED] Permission elevation is disabled."
        domains = [d.strip() for d in network_domains.split(",") if d.strip()]
        return await request_permissions_fn(reason, domains)

    unified = (
        execution_service is not None
        and execution_service._exec_cfg.unified_shell
    )
    shell_tools = [exec_command, write_stdin] if unified else []
    memory_tools = [memory_search, memory_read, memory_list, memory_add_note] if use_memories else []
    skill_tools = [skill_list, skill_read]
    perm_tools = [request_permissions] if allow_request_permissions and request_permissions_fn else []
    tools = [
        *shell_tools, run_node,
        *memory_tools, *skill_tools, *perm_tools,
        read_file, list_files, search_documents, think, ask_user_choice,
        present_files,
    ]
    if not disable_write_tools:
        tools.extend([apply_patch, write_file, write_binary_artifact])

    if allowed_tools is not None:
        tools = [t for t in tools if t.name in allowed_tools]
    return tools
