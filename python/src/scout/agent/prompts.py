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
2. **Prefer action over asking.** Use your tools to accomplish the \
   task directly. Only ask for clarification when genuinely ambiguous.
3. **Be concise.** Short tasks get short answers. Deep analysis gets \
   detailed responses. Let the user's request set the depth.

## Working Directory & Available Data

{manifest}

## Tools at Your Disposal

- **`run_code`** — Execute Python in a persistent session. Variables \
  and imports persist across calls. Use for computation, \
  data analysis, or any coding task.
- **`write_file`** — Create or overwrite a file at a given path. \
  Preferred over run_code for writing text files since the user gets \
  a clear preview. All writes require user approval.
- **`read_file`** — Read file contents.
- **`list_files`** — List directory contents.
- **`search_documents`** — Keyword search across indexed text, PDF, \
  and JSON documents.
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
- **Do not generate plots.** Avoid `matplotlib` / `seaborn` plotting calls \
  (`plt.plot`, `plt.show`, etc.). Plot images are not returned as tool \
  output in this pipeline; use tabular/statistical summaries instead.

## File Writing

- **All file writes require user approval** — the user sees a diff \
  and must approve before the write is committed.
- If the user suggests changes, revise and try again.
- If the user declines, acknowledge and move on.
- Writes via `run_code` (e.g. `df.to_csv(...)`) are also tracked \
  and require approval.

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
    except PermissionError:
        return f"{prefix}(permission denied)"

    for entry in entries:
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            lines.append(f"{prefix}📁 {entry.name}/")
            # One level deeper
            for child in sorted(entry.iterdir()):
                if child.name.startswith("."):
                    continue
                size = ""
                if child.is_file():
                    mb = child.stat().st_size / (1024 * 1024)
                    size = f"  ({mb:.1f} MB)" if mb >= 0.1 else ""
                icon = "📁" if child.is_dir() else "  "
                lines.append(f"{prefix}  {icon} {child.name}{size}")
        else:
            size = ""
            mb = entry.stat().st_size / (1024 * 1024)
            size = f"  ({mb:.1f} MB)" if mb >= 0.1 else ""
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
) -> str:
    """Scan *data_dir* and produce a human-readable manifest string.

    Includes:
    - Full file tree (2 levels deep) with file sizes
    - Column headers for every CSV found
    - Structure preview for every JSON found
    - Source descriptions from config (csv_sources / json_sources)
    """
    root = Path(data_dir)
    parts: list[str] = []

    # Collect descriptions from config for annotation
    csv_descriptions: dict[str, str] = {}
    json_descriptions: dict[str, str] = {}
    if config:
        for fname, src in config.csv_sources.items():
            if src.description:
                csv_descriptions[fname] = src.description
        for fname, src in config.json_sources.items():
            if src.description:
                json_descriptions[fname] = src.description

    # 1) File tree
    parts.append(f"**Data directory:** `{root}`\n")
    parts.append("```")
    parts.append(_file_tree(root))
    parts.append("```\n")

    # 2) CSV column inventories
    csv_files = sorted(root.rglob("*.csv"))
    if csv_files:
        parts.append("**CSV column inventories:**\n")
        for csv_path in csv_files:
            rel = csv_path.relative_to(root)
            cols = _csv_columns(csv_path)
            if cols:
                desc = csv_descriptions.get(csv_path.name, "")
                desc_line = f"  _{desc}_\n" if desc else ""
                parts.append(f"- `{rel}`\n{desc_line}{cols}\n")

    # 3) JSON structure previews
    json_files = sorted(root.rglob("*.json"))
    if json_files:
        parts.append("**JSON structure:**\n")
        for json_path in json_files:
            rel = json_path.relative_to(root)
            preview = _json_preview(json_path)
            if preview:
                desc = json_descriptions.get(json_path.name, "")
                desc_line = f"  _{desc}_\n" if desc else ""
                parts.append(f"- `{rel}`\n{desc_line}{preview}\n")

    # 4) Text / Markdown files (just list them)
    text_files = sorted(
        list(root.rglob("*.txt")) + list(root.rglob("*.md"))
    )
    if text_files:
        parts.append("**Text / Markdown documents** (searchable via `search_documents`):\n")
        for tf in text_files:
            rel = tf.relative_to(root)
            parts.append(f"- `{rel}`")
        parts.append("")

    return "\n".join(parts)


# ── Public entry point ───────────────────────────────────────────────────


def build_system_prompt(
    data_dir: str,
    config: "AppConfig | None" = None,
    skills_text: str = "",
    disable_write_tools: bool = False,
) -> str:
    """Return the system prompt with a pre-built data manifest injected.

    Parameters
    ----------
    data_dir : str
        Root directory containing the data files.
    config : AppConfig | None
        Application config (for source descriptions in the manifest).
    skills_text : str
        Domain-specific skills text to inject (from .scout/skills/ files).
    """
    manifest = build_manifest(data_dir, config=config)
    skills_section = ""
    if skills_text.strip():
        skills_section = f"\n## Domain Skills\n\n{skills_text}\n"

    prompt = SYSTEM_PROMPT.format(manifest=manifest, skills_section=skills_section)

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
