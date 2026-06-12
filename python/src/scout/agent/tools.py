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

from .file_guard import is_path_denied, is_name_denied, scan_code_for_denied_paths, WorkspaceGuard

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
    """Create tool functions, binding resources via closures."""

    data_dir = str(Path(data_dir).resolve())
    _fallback_exts = {".txt", ".md", ".json", ".csv"}

    def _read_denied(p: Path) -> bool:
        return guard.is_read_denied(p) if guard else is_path_denied(p)

    def _write_denied(p: Path) -> bool:
        return guard.is_write_denied(p) if guard else is_path_denied(p)

    def _fallback_search_documents(query: str, top_k: int) -> str:
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
            return "(no matching documents found)"

        hits.sort(key=lambda x: (-x[0], x[1]))
        parts = [
            f"[{i}] {src} (fallback score: {score})\n{snippet}"
            for i, (score, src, snippet) in enumerate(hits[:top_k], 1)
        ]
        return "\n\n---\n\n".join(parts)

    # ── Execution tools ──────────────────────────────────────────────

    @tool
    async def run_python(code: str, description: str = "") -> str:
        """Execute Python code in a persistent sandboxed session.

        Variables, imports, and DataFrames persist across calls.
        Use for data analysis, computation, and coding tasks.
        For saving files use write_file or write_binary_artifact instead.
        """
        if execution_service:
            result = await execution_service.run_python(code, description)
            return result.text
        return _legacy_run_code(code)

    @tool
    async def run_code(code: str, description: str = "") -> str:
        """Backwards-compatible alias for run_python."""
        return await run_python.ainvoke({"code": code, "description": description})

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
        """
        if not execution_service or not execution_service.enabled:
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
        if not execution_service or not execution_service.enabled:
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
        if not execution_service or not execution_service.enabled:
            return "[SANDBOX UNAVAILABLE] Shell execution requires an active execution sandbox."
        result = await execution_service.run_shell(command, description)
        return result.text

    @tool
    async def run_node(code: str, description: str = "") -> str:
        """Execute JavaScript/Node.js code in an isolated sandbox."""
        if not execution_service or not execution_service.enabled:
            return "[SANDBOX UNAVAILABLE] Node execution requires an active execution sandbox."
        result = await execution_service.run_node(code, description)
        return result.text

    def _legacy_run_code(code: str) -> str:
        if session is None:
            return "[SANDBOX UNAVAILABLE] Code execution is disabled."
        path_checker = guard.is_read_denied if guard else None
        denied = scan_code_for_denied_paths(code, base_dir=data_dir, path_checker=path_checker)
        if denied:
            return (
                f"[Access denied: your code attempts to access protected files: "
                f"{', '.join(denied)}]"
            )
        try:
            output, success = session.run(code, timeout=15)
        except Exception as exc:
            return f"[Session error: {exc}]"
        if not output:
            return "[Code ran successfully but produced no output. Use explicit print(...).]"
        return output

    # ── 2. read_file ─────────────────────────────────────────────────

    @tool
    def read_file(path: str, max_lines: int = 200) -> str:
        """Read a file and return its first *max_lines* lines as text."""
        p = Path(path)
        if not p.is_absolute():
            p = Path(data_dir) / p
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
        p = Path(directory)
        if not p.is_absolute():
            p = Path(data_dir) / p
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
    def search_documents(query: str, top_k: int = 5) -> str:
        """Search text, PDF, and JSON documents using keyword matching."""
        chunks = retriever.search(query, top_k=top_k)
        if not chunks:
            return _fallback_search_documents(query, top_k=top_k)

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
    def think(reflection: str) -> str:
        """Pause to reason through your analysis strategy before acting."""
        return "[Thought recorded — continue with your plan.]"

    @tool
    def ask_human(question: str) -> str:
        """Ask the user a clarifying question before proceeding."""
        return question

    _pdf_cache: dict[str, tuple[str, int]] = {}

    @tool
    def read_pdf(
        path: str,
        query: str = "",
        pages: str = "",
        max_chars: int = 3000,
    ) -> str:
        """Extract and search PDF content (in-memory, nothing saved to disk)."""
        from ..pdf_reader import extract_pdf_text, search_pdf_text

        p = Path(path)
        if not p.is_absolute():
            p = Path(data_dir) / p

        if _read_denied(p):
            return f"[Access denied: {p.name} is a protected file]"

        abs_key = str(p.resolve())

        if abs_key in _pdf_cache:
            full_text, total_pages = _pdf_cache[abs_key]
        else:
            try:
                full_text, total_pages = extract_pdf_text(p, pages=pages)
            except FileNotFoundError:
                parent = p.parent
                if parent.is_dir():
                    siblings = sorted(
                        f.name for f in parent.iterdir()
                        if f.is_file() and f.suffix.lower() == ".pdf"
                    )
                    listing = "\n  ".join(siblings[:20]) or "(none)"
                    return (
                        f"[PDF not found: {p.name}]\n"
                        f"PDFs in {parent}:\n  {listing}"
                    )
                return f"[PDF not found: {p}]"
            except Exception as exc:
                return f"[Error reading PDF: {exc}]"

            if not pages:
                _pdf_cache[abs_key] = (full_text, total_pages)

        if query:
            chunks = search_pdf_text(full_text, query, top_k=5)
            if not chunks:
                return f"(no passages matching '{query}' in {p.name})"
            parts = [f"[{i+1}] {chunk}" for i, chunk in enumerate(chunks)]
            result = f"Search results for '{query}' in {p.name}:\n\n" + "\n\n---\n\n".join(parts)
            return result[:max_chars]

        word_count = len(full_text.split())
        header = (
            f"**{p.name}**\n"
            f"Pages: {total_pages}, Words: ~{word_count}\n\n"
        )
        body = full_text[:max_chars - len(header)]
        if len(full_text) > max_chars - len(header):
            body += "\n\n… [truncated — use `query` parameter for targeted search]"
        return header + body

    @tool
    def apply_patch(patch: str, description: str = "") -> str:
        """Apply a unified diff patch to one or more files. Requires user approval."""
        return "Patch application is handled by the approval layer."

    @tool
    def write_file(path: str, content: str, description: str = "") -> str:
        """Write text content to a file. Requires user approval."""
        p = Path(path)
        if not p.is_absolute():
            p = Path(data_dir) / p
        if _write_denied(p):
            return f"[Access denied: cannot write to {p}]"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"Wrote {len(content)} characters to {p}"

    @tool
    def write_binary_artifact(path: str, content_base64: str, mime_type: str, description: str = "") -> str:
        """Save base64-encoded in-memory output such as a PNG or SVG."""
        return "Binary artifact write is handled by the approval layer."

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
        """Add an ad-hoc memory note (only when user explicitly requested)."""
        return _mem_backend.add_ad_hoc_note(slug, content)

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
        run_python, run_code, *shell_tools, run_node,
        *memory_tools, *skill_tools, *perm_tools,
        read_file, list_files, search_documents, think, ask_human, read_pdf,
    ]
    if not disable_write_tools:
        tools.extend([apply_patch, write_file, write_binary_artifact])

    if allowed_tools is not None:
        tools = [t for t in tools if t.name in allowed_tools]
    return tools
