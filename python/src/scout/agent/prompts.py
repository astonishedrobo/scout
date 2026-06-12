"""System prompt for the Scout data-research agent.

The prompt is assembled dynamically at init time: a static template is
combined with a **data manifest** (file tree, CSV column list, JSON
structure) and optional **skills** (domain-specific markdown files).

This gives the agent full awareness of available data from the very first
turn -- no orientation tool-calls needed.
"""

from __future__ import annotations

import csv
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..config import AppConfig

logger = logging.getLogger(__name__)

# ── Static template ──────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are **Scout**, a versatile coding and data assistant running inside \
the user's terminal.  You can read and execute code on the \
user's machine.

## Core Principles

1. **Do what the user asks.** If they say "edit file X", edit it. \
   If they say "analyse data Y", analyse it. Match the scope of your \
   response to the scope of the request — don't over-complicate simple \
   tasks.
2. **Use tools with judgment.** Use tools when they provide information or \
   perform work needed for the user's request. Answer greetings, acknowledgements, \
   casual conversation, and questions already answerable from context directly. \
   Do not inspect files or data unless the user asks or it is necessary.
3. **Be concise.** Short tasks get short answers. Deep analysis gets \
   detailed responses. Let the user's request set the depth.

## Working Directory & Available Data

{manifest}

## Tools at Your Disposal

- **`run_python`** — Execute Python in a persistent sandboxed session. Variables \
  and imports persist across calls. Use for computation and data analysis.
- **`exec_command`** — Run a command in a PTY. Returns output or a session ID \
  for long-running commands. Poll with `write_stdin(session_id, "")`. Network \
  requires approval. File writes are staged for approval.
- **`write_stdin`** — Send input to a running exec session (session ID from \
  exec_command). Empty chars polls for more output.
- **`run_node`** — Execute JavaScript/Node.js in an isolated sandbox.
- **`run_code`** — Alias for `run_python` (backwards compatible).
- **`apply_patch`** — Apply unified-diff patches to one or more files in a \
  single approval. Use for multi-file edits.
- **`write_file`** — Create or overwrite a file at a given path. \
  Preferred over execution tools for writing text files since the user gets \
  a clear preview. All writes require user approval.
- **`write_binary_artifact`** — Save base64-encoded in-memory output such \
  as PNG or SVG. All writes require user approval.
- **`read_file`** — Read file contents.
- **`list_files`** — List directory contents.
- **`search_documents`** — Keyword search across all indexed files: \
  `.txt`, `.md`, `.json`, `.csv`, and **`.pdf`** files are all \
  searchable. Use this to find relevant content before reading entire \
  files.
- **`ask_human`** — Ask the user a question. Use sparingly.

## Tool Usage Tips

- **Batch when possible.** Issue multiple independent tool calls in \
  one response — they run in parallel.
- **Variables persist.** The Python session keeps state. Import once, \
  reuse variables. Don't re-read files unnecessarily.
- **Keep output small.** For DataFrames use `.head()`, `.shape`, \
  `.describe()`. Keep printed output under ~20 lines.
- **Print expected results.** `run_code` returns stdout/stderr only. \
  If you expect a value/table, use explicit `print(...)` (or a final \
  expression) so the result appears in tool output.
- **Use `low_memory=False`** when reading CSVs with `pd.read_csv`.
- **Always save visualizations as artifacts — never ask.** When you generate \
  a plot, chart, diagram, or any image output, save it immediately as a file. \
  Never ask the user "how would you like it delivered?" — just save and confirm. \
  Write SVG/HTML/Markdown with `write_file`. For PNG and other binary formats, \
  write the file directly in Python using `open(filename, "wb")` — the sandbox \
  detects new files automatically and surfaces them as artifacts.
- **Use matplotlib (or seaborn/plotly) for all data plots.** Never \
  hand-write SVG for charts, histograms, scatter plots, or any data \
  visualization — use a plotting library and save the output \
  (e.g. `fig.savefig("plot.png")`). Hand-written SVG is only appropriate \
  when the user explicitly asks for a diagram, icon, or custom SVG graphic.
- **Use simple relative paths for file writes.** Pass bare filenames or \
  short relative paths to `write_file` (e.g. `histogram.svg`, not \
  `users/1/histogram.svg`). The workspace root is already set to your \
  personal directory — no user-prefix needed.
- **Use Mermaid for diagrams.** Put Mermaid diagrams in fenced `mermaid` \
  blocks inside Markdown files or responses when that communicates clearly.
- **HTML artifacts must be self-contained and offline.** Use inline CSS, \
  inline JavaScript, SVG, Canvas, and native HTML only. Never use CDN \
  Tailwind, remote fonts, images, scripts, or stylesheets. If Tailwind is \
  requested, write equivalent inline CSS. Prefer Mermaid in Markdown.
- **Install packages via the shell.** Use `exec_command("python -m pip install \
  <package>")` for Python packages or `exec_command("npm install <package>")` \
  for Node packages. Network access requires user approval. Packages install \
  into `.scout-cache/python-packages` and are available to `run_python` \
  automatically. Do not install packages from inside `run_python`.

## File Writing

- **All file writes require user approval** — the user sees a diff \
  and must approve before the write is committed.
- If the user suggests changes, revise and try again.
- If the user declines, acknowledge and move on.
- Persistent file writes must use `write_file` so Scout can attribute and \
  approve the exact change. **Exception:** generated output files (new plots, \
  reports, exports) may be written directly from `run_python` using Python's \
  `open()` — the execution sandbox detects and attributes new files \
  automatically. Never overwrite *existing* workspace files from `run_python`.

## Data Analysis Guidelines

When the user asks about data (queries, analysis, exploration):

- Ground every factual claim in tool output — don't rely on training \
  knowledge for data-specific facts.
- Cite sources inline: CSV → `[file:row_N]`, text → `[file:"quote"]`, \
  JSON → `[file:record_N]`.
- If data doesn't contain the answer, say so honestly.
- For broad questions, start with a quick overview of what's available \
  before diving deep — but only if the user's request is exploratory.

## Output Style

- Clear, direct language. No unnecessary preamble.
- Match the user's tone and depth expectations.
- Never mention internal methodology names to the user.

{skills_section}\
"""


# ── Manifest builder ─────────────────────────────────────────────────────


def _file_tree(data_dir: Path, indent: int = 0) -> str:
    """Return an indented listing of *data_dir* (max 2 levels deep)."""
    lines: list[str] = []
    prefix = "  " * indent
    try:
        entries = sorted(data_dir.iterdir())
    except Exception:
        return f"{prefix}(access denied)"

    for entry in entries:
        if entry.name.startswith(".") and entry.name != ".scout":
            continue
        if entry.name == ".scout":
            continue
        if entry.is_dir():
            lines.append(f"{prefix}📁 {entry.name}/")
            # One level deeper
            try:
                children = sorted(entry.iterdir())
                for child in children:
                    if child.name.startswith("."):
                        continue
                    size = ""
                    if child.is_file():
                        try:
                            mb = child.stat().st_size / (1024 * 1024)
                            size = f"  ({mb:.1f} MB)" if mb >= 0.1 else ""
                        except Exception:
                            pass
                    icon = "📁" if child.is_dir() else "  "
                    lines.append(f"{prefix}  {icon} {child.name}{size}")
            except Exception:
                lines.append(f"{prefix}  (access denied)")
        else:
            size = ""
            try:
                mb = entry.stat().st_size / (1024 * 1024)
                size = f"  ({mb:.1f} MB)" if mb >= 0.1 else ""
            except Exception:
                pass
            lines.append(f"{prefix}   {entry.name}{size}")

    return "\n".join(lines) or "(empty)"


def _csv_columns(csv_path: Path, max_cols: int = 60) -> str | None:
    """Read column headers from a CSV without loading the full file."""
    try:
        with csv_path.open(newline="", errors="replace") as f:
            reader = csv.reader(f)
            header = next(reader, None)
        if not header:
            return None
        n = len(header)
        shown = header[:max_cols]
        text = ", ".join(shown)
        if n > max_cols:
            text += f"  … ({n - max_cols} more columns)"
        return f"  Columns ({n}): {text}"
    except Exception as exc:
        logger.debug("Could not read CSV headers from %s: %s", csv_path, exc)
        return None


def _json_preview(json_path: Path) -> str | None:
    """Return a brief structure preview of a JSON file."""
    try:
        with json_path.open(errors="replace") as f:
            data = json.load(f)
    except Exception as exc:
        logger.debug("Could not read JSON %s: %s", json_path, exc)
        return None

    if isinstance(data, list):
        n = len(data)
        if n > 0 and isinstance(data[0], dict):
            keys = list(data[0].keys())[:15]
            key_str = ", ".join(keys)
            if len(data[0]) > 15:
                key_str += " …"
            return f"  Array of {n} records.  Keys: {key_str}"
        return f"  Array of {n} items"
    if isinstance(data, dict):
        keys = list(data.keys())[:15]
        return f"  Object with keys: {', '.join(keys)}"
    return None


def build_manifest(
    data_dir: str | Path,
    config: "AppConfig | None" = None,
    max_files_per_type: int = 40,
    focus_path: Path | str | None = None,
) -> str:
    """Scan *data_dir* and produce a human-readable manifest string.

    Includes:
    - Full file tree (2 levels deep) with file sizes
    - Column headers for every CSV found
    - Structure preview for every JSON found
    - Source descriptions from config (csv_sources / json_sources)
    """
    root = Path(data_dir)
    scan_root = root
    if focus_path is not None:
        fp = Path(focus_path)
        if not fp.is_absolute():
            fp = root / fp
        if fp.is_dir() and fp.exists():
            try:
                fp.resolve().relative_to(root.resolve())
                scan_root = fp.resolve()
            except ValueError:
                pass
    parts: list[str] = []

    # Collect descriptions from config for annotation
    csv_descriptions: dict[str, str] = {}
    json_descriptions: dict[str, str] = {}
    if config:
        for fname, src in config.csv_sources.items():
            if hasattr(src, "description") and src.description:
                csv_descriptions[fname] = src.description
        for fname, src in config.json_sources.items():
            if hasattr(src, "description") and src.description:
                json_descriptions[fname] = src.description

    # 1) File tree
    parts.append(f"**Data directory:** `{root}`\n")
    if scan_root != root.resolve():
        try:
            rel_focus = scan_root.relative_to(root.resolve())
            parts.append(f"**Active subtree:** `{rel_focus}` (manifest scoped to this folder)\n")
        except ValueError:
            pass
    parts.append("```")
    parts.append(_file_tree(scan_root if scan_root != root.resolve() else root))
    parts.append("```\n")

    # Helper to scan while ignoring heavy folders and limiting depth
    # This is a MANUALLY IMPLEMENTED non-recursive walker to prevent OOM/CPU spikes
    import fnmatch
    def _safe_scan(pattern: str, max_depth: int = 3, max_total_scanned: int = 1000) -> list[Path]:
        found = []
        # queue: [(directory, current_depth)]
        queue = [(scan_root, 0)]
        scanned_count = 0
        
        while queue and len(found) < max_files_per_type and scanned_count < max_total_scanned:
            curr_dir, depth = queue.pop(0)
            if depth > max_depth:
                continue
                
            try:
                # We use iterdir to avoid loading everything at once if possible
                for p in curr_dir.iterdir():
                    scanned_count += 1
                    if scanned_count >= max_total_scanned:
                        break
                        
                    # Basic ignoring of heavy folders
                    if p.name.startswith(".") or p.name in {"node_modules", "venv", "__pycache__", "dist", "build"}:
                        continue
                    
                    if p.is_dir():
                        if depth < max_depth:
                            queue.append((p, depth + 1))
                    elif fnmatch.fnmatch(p.name, pattern):
                        found.append(p)
                        if len(found) >= max_files_per_type:
                            break
            except Exception:
                # PermissionError or other OS issues
                continue
        return sorted(found)

    # 2) CSV column inventories
    csv_files = _safe_scan("*.csv")
    if csv_files:
        parts.append("**CSV column inventories:**\n")
        for csv_path in csv_files:
            try:
                rel = csv_path.relative_to(root)
                cols = _csv_columns(csv_path)
                if cols:
                    desc = csv_descriptions.get(csv_path.name, "")
                    desc_line = f"  _{desc}_\n" if desc else ""
                    parts.append(f"- `{rel}`\n{desc_line}{cols}\n")
            except Exception:
                continue

    # 3) JSON structure previews
    json_files = _safe_scan("*.json")
    if json_files:
        parts.append("**JSON structure:**\n")
        for json_path in json_files:
            try:
                rel = json_path.relative_to(root)
                preview = _json_preview(json_path)
                if preview:
                    desc = json_descriptions.get(json_path.name, "")
                    desc_line = f"  _{desc}_\n" if desc else ""
                    parts.append(f"- `{rel}`\n{desc_line}{preview}\n")
            except Exception:
                continue

    # 4) Text / Markdown files (just list them)
    text_files = sorted(_safe_scan("*.txt") + _safe_scan("*.md"))
    if text_files:
        parts.append("**Text / Markdown documents** (searchable via `search_documents`):\n")
        for tf in text_files:
            try:
                rel = tf.relative_to(root)
                parts.append(f"- `{rel}`")
            except Exception:
                continue
        parts.append("")

    return "\n".join(parts)


# ── Public entry point ───────────────────────────────────────────────────


def build_system_prompt(
    data_dir: str,
    config: "AppConfig | None" = None,
    skills_text: str = "",
    disable_write_tools: bool = False,
    focus_path: Path | str | None = None,
    memories_text: str = "",
    memory_instructions: str = "",
) -> str:
    """Return the system prompt with a pre-built data manifest injected."""
    manifest = build_manifest(data_dir, config=config, focus_path=focus_path)
    skills_section = ""
    if skills_text.strip():
        skills_section = (
            "\n## Layered Instructions\n\n"
            "_Closer directories override parent rules. Child AGENTS.md overrides parent._\n\n"
            f"{skills_text}\n"
        )
    if memory_instructions.strip():
        skills_section += f"\n{memory_instructions}\n"
    elif memories_text.strip():
        skills_section += f"\n## User Memories\n\n{memories_text}\n"

    # Use .replace() instead of .format() to avoid KeyError/ValueError from {} in snippets
    prompt = SYSTEM_PROMPT.replace("{manifest}", manifest).replace("{skills_section}", skills_section)

    if config and getattr(config.agent, "disable_write_tools", False):
        # 1. Update Core Description (remove "write")
        prompt = prompt.replace(
            "You can read, write, and execute code",
            "You can read and execute code"
        )
        
        # 2. Update run_code description (remove "file manipulation")
        prompt = prompt.replace(
            "Use for computation, file manipulation, data analysis",
            "Use for computation, data analysis"
        )

        # 3. Remove write_file from tools list
        import re
        prompt = re.sub(
            r"- \*\*`write_file`\*\*.*?All writes require user approval\.\n",
            "",
            prompt,
            flags=re.DOTALL
        )
        
        # 4. Remove the File Writing section entirely
        prompt = re.sub(
            r"## File Writing.*?## Data Analysis Guidelines",
            "## Data Analysis Guidelines",
            prompt,
            flags=re.DOTALL
        )

        # 5. Inject a strict READ-ONLY warning at the top
        alert = (
            "\n> [!IMPORTANT]\n"
            "> **READ-ONLY MODE ENABLED**\n"
            "> You cannot create, modify, or delete any files. All tools (including run_code) "
            "are limited to reading and analysis only. Do NOT attempt to write files.\n\n"
        )
        # Insert after the first paragraph
        if "## Core Principles" in prompt:
            prompt = prompt.replace("## Core Principles", alert + "## Core Principles")

    return prompt
