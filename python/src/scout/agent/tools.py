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

from .file_guard import is_path_denied, is_name_denied, scan_code_for_denied_paths

if TYPE_CHECKING:
    from ..retriever import BM25Retriever
    from .session import PersistentPythonSession


# ── Factory ──────────────────────────────────────────────────────────────


def make_tools(
    session: "PersistentPythonSession",
    retriever: "BM25Retriever",
    data_dir: str | Path,
    disable_write_tools: bool = False,
) -> list:
    """Create tool functions, binding *session* and *retriever* via closures."""

    data_dir = str(Path(data_dir).resolve())
    _fallback_exts = {".txt", ".md", ".json", ".csv"}

    def _fallback_search_documents(query: str, top_k: int) -> str:
        """Config-free local text search across common data file types."""
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
            if is_name_denied(fpath.name) or is_path_denied(fpath):
                continue
            try:
                if fpath.stat().st_size > 2_000_000:  # 2 MB guard
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

    # ── 1. run_code ──────────────────────────────────────────────────

    @tool
    def run_code(code: str, description: str = "") -> str:
        """Execute Python code in a persistent session.

        **When to use:** Any data analysis — loading CSVs, filtering
        DataFrames, computing statistics/z-scores, data transformations.
        This is your primary analysis tool.  Variables, imports, and
        DataFrames persist across calls, so import once and reuse.

        **When NOT to use:** Reading a text/markdown file (use read_file).
        Searching documents for qualitative info (use search_documents).

        **Tips:**
        - Always `pd.read_csv(..., low_memory=False)` for CSVs.
        - Never `print(df)` — use `.head()`, `.shape`, `.describe()`, `.T`.
        - Do not generate plots (`matplotlib` / `seaborn`); plot images are
          not returned as tool output in this pipeline.
        - Batch related operations in one call.
        - For shell: `import subprocess; subprocess.run(...)`.

        Parameters
        ----------
        code : str
            Python code to execute.
        description : str
            Brief description of what this code does (shown to the user).
        """
        denied = scan_code_for_denied_paths(code)
        if denied:
            return (
                f"[Access denied: code attempts to access protected file(s): "
                f"{', '.join(denied)}. Rewrite without accessing sensitive files.]"
            )
        output, success = session.run(code)
        if not output:
            return (
                "[Code ran successfully but produced no output. "
                "If you expected a result, rerun with explicit print(...).]"
            )
        return output

    # ── 2. read_file ─────────────────────────────────────────────────

    @tool
    def read_file(path: str, max_lines: int = 200) -> str:
        """Read a file and return its first *max_lines* lines as text.

        **When to use:** Peeking at text/markdown documents, checking
        the first few lines of a CSV or JSON to understand structure,
        reading configuration files.

        **When NOT to use:** Heavy data analysis on CSVs (use run_code
        with pandas instead — it's faster and supports filtering).

        **Note:** If the file is not found, this tool lists all files
        in the parent directory so you can find the correct filename.

        Parameters
        ----------
        path : str
            Absolute or relative path (relative paths resolved from the
            data directory).  Use filenames from the manifest or from
            list_files output.
        max_lines : int
            Maximum number of lines to return (default 200).
        """
        p = Path(path)
        if not p.is_absolute():
            p = Path(data_dir) / p
        if is_path_denied(p):
            return f"[Access denied: {p.name} is a protected file]"
        if not p.exists():
            parent = p.parent
            if parent.is_dir():
                siblings = sorted(
                    f.name for f in parent.iterdir()
                    if f.is_file() and not is_name_denied(f.name)
                )
                listing = "\n  ".join(siblings[:30]) or "(empty)"
                return (
                    f"[File not found: {p.name}]\n"
                    f"Files in {parent.relative_to(data_dir)}:\n  {listing}"
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

    # ── 3. list_files ──────────────────────────────────────────────────

    @tool
    def list_files(directory: str = ".") -> str:
        """List files and sub-directories in a directory.

        **When to use:** Exploring a sub-directory not fully described
        in the manifest, or checking for newly added files.

        **When NOT to use:** You already know the filenames from the
        system manifest — go directly to read_file or run_code.

        Parameters
        ----------
        directory : str
            Path relative to the data directory (default: root data dir).
        """
        p = Path(directory)
        if not p.is_absolute():
            p = Path(data_dir) / p
        if is_path_denied(p):
            return f"[Access denied: {p.name} is a protected directory]"
        if not p.is_dir():
            return f"[Not a directory: {p}]"
        entries = sorted(p.iterdir())
        lines: list[str] = []
        shown = 0
        for e in entries:
            if is_name_denied(e.name):
                continue
            if e.is_dir() and e.name.lower() in {".ssh", ".gnupg", ".aws", ".docker"}:
                continue
            prefix = "📁 " if e.is_dir() else "   "
            lines.append(f"{prefix}{e.name}")
            shown += 1
            if shown >= 50:
                break
        result = "\n".join(lines) or "(empty)"
        if len(entries) > shown:
            result += f"\n… (more entries)"
        return result

    # ── 4. search_documents ─────────────────────────────────────────

    @tool
    def search_documents(query: str, top_k: int = 5) -> str:
        """Search text, PDF, and JSON documents using keyword matching.

        **When to use:** Finding qualitative / contextual information
        about an entity, region, or topic from narrative sources
        (reports, records, notes, and other documents).

        **When NOT to use:** Looking up numeric data from CSVs (use
        run_code with pandas instead).

        **Tips:**
        - Try multiple queries with different angles: zone name,
          parent district, specific topic (e.g. "flood", "drought").
        - A single search often misses context — 2-3 queries with
          varied keywords gives much better coverage.

        Parameters
        ----------
        query : str
            Search query (e.g. "Nagaon district flood vulnerability").
        top_k : int
            Number of chunks to return (default 5).
        """
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

    # ── 5. think ─────────────────────────────────────────────────────

    @tool
    def think(reflection: str) -> str:
        """Pause to reason through your analysis strategy before acting.

        **When to use:** Planning a multi-step investigation, deciding
        which data sources to consult, reasoning about what a filename
        might contain, or synthesising findings before writing a report.

        Use this BEFORE diving into code — a 2-sentence plan saves
        wasted tool calls.

        Parameters
        ----------
        reflection : str
            Your private reasoning / plan (not shown to the user).
        """
        return "[Thought recorded — continue with your plan.]"

    # ── 6. ask_human ───────────────────────────────────────────────

    @tool
    def ask_human(question: str) -> str:
        """Ask the user a clarifying question before proceeding.

        **When to use (rarely):**
        - You are blocked by a missing decision the user must make.
        - Multiple valid interpretations exist and choosing one could
          materially change the answer.
        - A required input/constraint is absent and cannot be derived
          from available data or prior conversation.

        **When NOT to use (most of the time):**
        - You can make a reasonable assumption and proceed — prefer
          action over asking.
        - The query is clear enough to start exploring data.
        - You're just unsure about the *answer* — that's what tools
          are for; explore the data instead of asking.

        **Question quality:**
        - Ask one focused question at a time.
        - Explain briefly why the choice matters.
        - If useful, offer 2-4 concrete options.

        **Examples (illustrative, not exhaustive):**
        - "I found multiple entities with this name. Which one should I use?"
        - "Should I compare by region, time period, or category?"

        Parameters
        ----------
        question : str
            The clarifying question to ask the user.
        """
        # Body is never executed — agent_node intercepts this tool call
        # and converts it to a plain text response.
        return question

    # ── 7. read_pdf ────────────────────────────────────────────────

    # Session-level cache: {abs_path -> extracted_text}
    _pdf_cache: dict[str, str] = {}

    @tool
    def read_pdf(
        path: str,
        query: str = "",
        pages: str = "",
        max_chars: int = 3000,
    ) -> str:
        """Extract and search PDF content (in-memory, nothing saved to disk).

        **When to use:** Exploring PDF documents attached via @ or found
        in the data directory.  Especially important for long PDFs where
        loading the full text would overflow context.

        **Strategy for long PDFs:**
        1. First call without query -> get overview + page count + first
           ~3000 chars.
        2. Then call with query -> get relevant passages only (BM25
           search within the PDF).

        **When NOT to use:** The PDF has already been converted to text
        and indexed (check the manifest for .md/.txt files).

        Parameters
        ----------
        path : str
            Path to the PDF file (absolute or relative to data dir).
        query : str
            If provided, searches the PDF text for relevant passages
            using BM25 and returns the top matches.
        pages : str
            Page range (e.g. "1-5", "3,7,12").  1-indexed.  Returns
            text from those pages only.
        max_chars : int
            Maximum characters to return (default 3000).
        """
        from ..pdf_reader import extract_pdf_text, search_pdf_text

        p = Path(path)
        if not p.is_absolute():
            p = Path(data_dir) / p

        if is_path_denied(p):
            return f"[Access denied: {p.name} is a protected file]"

        abs_key = str(p.resolve())

        # Check session cache
        if abs_key in _pdf_cache:
            full_text = _pdf_cache[abs_key]
            total_pages = 0  # unknown from cache
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

            # Cache for re-use within the session
            if not pages:
                _pdf_cache[abs_key] = full_text

        if query:
            # BM25 search within the extracted text
            chunks = search_pdf_text(full_text, query, top_k=5)
            if not chunks:
                return f"(no passages matching '{query}' in {p.name})"
            parts = [f"[{i+1}] {chunk}" for i, chunk in enumerate(chunks)]
            result = f"Search results for '{query}' in {p.name}:\n\n" + "\n\n---\n\n".join(parts)
            return result[:max_chars]

        # Overview mode: metadata + beginning of text
        word_count = len(full_text.split())
        header = (
            f"**{p.name}**\n"
            f"Pages: {total_pages}, Words: ~{word_count}\n\n"
        )
        body = full_text[:max_chars - len(header)]
        if len(full_text) > max_chars - len(header):
            body += "\n\n… [truncated — use `query` parameter for targeted search]"
        return header + body

    # ── 8. write_file ──────────────────────────────────────────────

    @tool
    def write_file(path: str, content: str, description: str = "") -> str:
        """Write text content to a file.  Requires user approval.

        **When to use:** Saving analysis results, generating reports,
        exporting processed data as text/CSV/JSON/Markdown.

        The user will be shown the file path and content, and must
        approve before the write proceeds.

        Parameters
        ----------
        path : str
            Target file path (absolute, or relative to the data directory).
        content : str
            The text content to write.
        description : str
            Brief human-readable description of what is being written.
        """
        p = Path(path)
        if not p.is_absolute():
            p = Path(data_dir) / p
        if is_path_denied(p):
            return f"[Access denied: cannot write to protected file {p.name}]"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"Wrote {len(content)} characters to {p}"

    tools = [run_code, read_file, list_files, search_documents, think, ask_human, read_pdf]
    if not disable_write_tools:
        tools.append(write_file)
    return tools
