"""LangGraph tool definitions for the Scout data-research agent.

Each tool is a plain function decorated with ``@tool``.  They close over
shared resources (session, retriever) which are injected at graph-build
time via :func:`make_tools`.
"""

from __future__ import annotations

import csv
from itertools import islice
from pathlib import Path
from typing import TYPE_CHECKING

from langchain_core.tools import tool

from .file_guard import is_path_denied, is_name_denied, WorkspaceGuard

if TYPE_CHECKING:
    from ..execution.service import ExecutionService
    from ..retriever import BM25Retriever
    from .session import PersistentPythonSession
    from .subagents import SubAgentManager


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
    subagent_manager: "SubAgentManager | None" = None,
    is_subagent: bool = False,
) -> list:
    """Create tool functions, binding resources via closures.

    ``session`` is accepted for call-site compatibility but unused
    (persistent ``run_python`` / ``run_code`` tools were removed).
    """

    data_dir = str(Path(data_dir).resolve())
    shared_root = getattr(guard, "_shared", None) if guard else None
    if shared_root is not None:
        shared_root = Path(shared_root)

    def _read_denied(p: Path) -> bool:
        return guard.is_read_denied(p) if guard else is_path_denied(p)

    def _write_denied(p: Path) -> bool:
        return guard.is_write_denied(p) if guard else is_path_denied(p)

    def _resolve_workspace_path(path: str) -> Path:
        """Map canonical agent paths into this tool's workspace roots."""
        from ..path_display import resolve_agent_workspace_path

        return resolve_agent_workspace_path(path, data_dir, shared_root)

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
    def read_file(path: str, max_lines: int = 200, offset: int = 1) -> str:
        """Read a text file from a 1-based line offset, returning at most max_lines."""
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
            if offset < 1:
                return "[Invalid offset: use a 1-based line number]"
            max_lines = max(1, min(int(max_lines), 1000))
            with p.open(encoding="utf-8", errors="replace") as handle:
                window = list(islice(handle, offset - 1, offset - 1 + max_lines + 1))
            has_more = len(window) > max_lines
            lines = [line.rstrip("\r\n") for line in window[:max_lines]]
            result = "\n".join(lines)
            if not lines:
                return f"[No content at or after line {offset}]"
            if has_more:
                end = offset + len(lines) - 1
                result += f"\n\n… [showing lines {offset}-{end}; use offset={end + 1} to continue]"
            return result
        except Exception as exc:
            return f"[Error reading {p}: {exc}]"

    @tool
    def list_files(directory: str = ".", offset: int = 1, max_entries: int = 50) -> str:
        """List a directory with a 1-based offset and bounded page size."""
        p = _resolve_workspace_path(directory)
        if _read_denied(p):
            return f"[Access denied: {p.name} is a protected directory]"
        if not p.is_dir():
            return f"[Not a directory: {p}]"
        if offset < 1:
            return "[Invalid offset: use a 1-based entry number]"
        max_entries = max(1, min(int(max_entries), 200))
        entries: list[Path] = []
        for e in sorted(p.iterdir()):
            if is_name_denied(e.name):
                continue
            if e.name in {".scout-cache", ".scout-executions"}:
                continue
            if e.is_dir() and e.name.lower() in {".ssh", ".gnupg", ".aws", ".docker", ".scout", ".git"}:
                continue
            entries.append(e)
        page = entries[offset - 1:offset - 1 + max_entries]
        lines: list[str] = []
        for e in page:
            prefix = "📁 " if e.is_dir() else "   "
            lines.append(f"{prefix}{e.name}")
        result = "\n".join(lines) or "(empty)"
        next_offset = offset + len(page)
        if next_offset <= len(entries):
            result += f"\n… [more entries; use offset={next_offset} to continue]"
        return result

    @tool
    def search_workspace(query: str, path: str = "", top_k: int = 5) -> str:
        """Ranked lexical search across workspace text, Markdown, JSON, and PDF.

        PDFs are parsed and indexed automatically. Optionally pass *path* to
        search one document. CSV is intentionally not indexed: use filter_table
        for exact row lookup, or exec_command with pandas for calculations.
        """
        source_file: str | None = None
        if path and path.strip():
            p = _resolve_workspace_path(path.strip())
            if _read_denied(p):
                return f"[Access denied: {p.name} is a protected file]"
            if p.suffix.lower() == ".csv":
                return (
                    "[UNSUPPORTED TARGET: search_workspace does not index CSV tables. "
                    "Use filter_table(path=..., query=...) for exact row lookup, or "
                    "exec_command with pandas for aggregation and calculations.]"
                )
            # Prefer resolved path so absolute/relative forms match the index.
            source_file = str(p) if p.exists() else path.strip()

        chunks = retriever.search(query, top_k=top_k, source_file=source_file)
        if not chunks:
            scope = f" in '{path.strip()}'" if path.strip() else ""
            return f"(no matching workspace content found{scope})"

        from ..path_display import display_path

        parts: list[str] = []
        for i, c in enumerate(chunks, 1):
            source_label = display_path(c.source_file, data_dir, shared_root)
            # If the index only stored a basename, resolve through shared/personal.
            if source_label == c.source_file and "/" not in c.source_file.replace("\\", "/"):
                resolved = _resolve_workspace_path(c.source_file)
                if resolved.exists():
                    source_label = display_path(resolved, data_dir, shared_root)
            header = f"[{i}] {source_label} (score: {c.score:.2f})"
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
    def filter_table(
        path: str,
        query: str,
        columns: list[str] | None = None,
        max_rows: int = 20,
    ) -> str:
        """Find CSV rows containing exact text without loading/indexing the table.

        Matching is case-insensitive and streams the CSV from disk. Optionally
        restrict matching to named columns. Use exec_command with pandas for
        sorting, aggregation, numeric comparisons, joins, or statistical work.
        """
        target = _resolve_workspace_path(path)
        if _read_denied(target):
            return f"[Access denied: {target.name} is a protected file]"
        if target.suffix.lower() != ".csv":
            return (
                f"[UNSUPPORTED TARGET: filter_table only accepts .csv files, not "
                f"{target.suffix or 'a file without an extension'}. Use "
                "search_workspace for PDF, Markdown, text, and narrative JSON.]"
            )
        if not target.is_file():
            return f"[File not found: {target}]"
        needle = query.strip().casefold()
        if not needle:
            return "[Invalid query: provide non-empty exact text to find]"
        if len(needle) > 500:
            return "[Invalid query: maximum length is 500 characters]"
        limit = max(1, min(int(max_rows), 50))
        requested = [str(column) for column in (columns or []) if str(column).strip()]
        matches: list[str] = []
        try:
            with target.open(newline="", encoding="utf-8", errors="replace") as handle:
                reader = csv.DictReader(handle)
                fieldnames = list(reader.fieldnames or [])
                if not fieldnames:
                    return "[Invalid CSV: no header row found]"
                unknown = [column for column in requested if column not in fieldnames]
                if unknown:
                    available = ", ".join(fieldnames[:30])
                    return (
                        f"[Unknown column(s): {', '.join(unknown)}. "
                        f"Available columns: {available}]"
                    )
                searched = requested or fieldnames
                for row_number, row in enumerate(reader, 2):
                    if not any(needle in str(row.get(column, "")).casefold() for column in searched):
                        continue
                    values = []
                    for column in fieldnames:
                        value = str(row.get(column, "") or "").strip()
                        if not value:
                            continue
                        if len(value) > 160:
                            value = value[:157] + "..."
                        values.append(f"{column}: {value}")
                    matches.append(f"row {row_number}: " + " | ".join(values))
                    if len(matches) >= limit:
                        break
        except (OSError, csv.Error) as exc:
            return f"[CSV read error: {exc}]"
        if not matches:
            scope = f" in columns {requested}" if requested else ""
            return f"(no CSV rows containing {query!r}{scope})"
        result = "\n".join(matches)
        if len(matches) == limit:
            result += f"\n… [showing at most {limit} matching rows]"
        return result

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

    # ── Multi-agent tools (parent only) ──────────────────────────────

    @tool
    async def spawn_subagent(
        description: str,
        prompt: str,
        agent_type: str = "trailhand",
        run_in_background: bool = True,
        resume_parent_on_complete: bool = False,
    ) -> str:
        """Launch a Scout sub-agent for a concrete, independent subtask.

        Prefer background mode so you can keep working; you will be notified
        when it finishes. Types: snoop (read-only search), cartographer
        (read-only plan), trailhand (multi-step work / timers / edits).
        Set resume_parent_on_complete only when you must perform additional
        supervisor work using the result. Leave it false when the worker's
        returned result itself completes the user's request.
        """
        if is_subagent or subagent_manager is None:
            return (
                "[SPAWN DENIED] Sub-agents cannot spawn further agents "
                "(max depth is 1)."
            )
        return await subagent_manager.spawn(
            description=description,
            prompt=prompt,
            agent_type=agent_type,
            run_in_background=run_in_background,
            resume_parent_on_complete=resume_parent_on_complete,
        )

    @tool
    def list_subagents() -> str:
        """List sub-agents spawned in this session and their status."""
        if is_subagent or subagent_manager is None:
            return "[UNAVAILABLE] Sub-agent listing is only available on the parent agent."
        return subagent_manager.list_agents()

    @tool
    def get_subagent_result(agent_id: str) -> str:
        """Fetch a finished sub-agent's result. Prefer automatic notifications over polling."""
        if is_subagent or subagent_manager is None:
            return "[UNAVAILABLE] Sub-agent results are only available on the parent agent."
        return subagent_manager.get_result(agent_id)

    @tool
    async def stop_subagent(agent_id: str) -> str:
        """Stop a running sub-agent when its direction is wrong or no longer needed."""
        if is_subagent or subagent_manager is None:
            return "[UNAVAILABLE] Stopping sub-agents is only available on the parent agent."
        return await subagent_manager.stop(agent_id)

    @tool
    async def send_subagent_message(agent_id: str, message: str) -> str:
        """Send a follow-up to an existing sub-agent (same thread). Prefer this over re-spawning."""
        if is_subagent or subagent_manager is None:
            return "[UNAVAILABLE] Messaging sub-agents is only available on the parent agent."
        return await subagent_manager.send_message(
            agent_id, message, source="parent",
        )

    unified = (
        execution_service is not None
        and execution_service._exec_cfg.unified_shell
    )
    shell_tools = [exec_command, write_stdin] if unified else []
    memory_tools = [memory_search, memory_read, memory_list, memory_add_note] if use_memories else []
    skill_tools = [skill_list, skill_read]
    perm_tools = [request_permissions] if allow_request_permissions and request_permissions_fn else []
    multi_agent_tools = []
    if not is_subagent and subagent_manager is not None and subagent_manager.enabled:
        multi_agent_tools = [
            spawn_subagent, list_subagents, get_subagent_result,
            stop_subagent, send_subagent_message,
        ]
    tools = [
        *shell_tools, run_node,
        *memory_tools, *skill_tools, *perm_tools, *multi_agent_tools,
        read_file, list_files, search_workspace, filter_table, think, ask_user_choice,
        present_files,
    ]
    if not disable_write_tools:
        tools.extend([apply_patch, write_file, write_binary_artifact])

    if allowed_tools is not None:
        tools = [t for t in tools if t.name in allowed_tools]
    return tools
