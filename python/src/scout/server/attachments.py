"""Attachment metadata extraction for the Scout server.

When a user references a file via ``@path``, the CLI resolves the path
and sends it as an attachment.  This module extracts lightweight metadata
for each attachment and generates a note that is appended to the user
message so the agent knows what tool to use.
"""

from __future__ import annotations

import csv
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def build_attachment_notes(file_paths: list[str]) -> str:
    """Generate attachment notes for a list of file paths.

    Returns a string block that should be appended to the user's message.
    Each file gets a ``[Attached: ...]`` line with metadata and a tool hint.
    """
    if not file_paths:
        return ""

    notes: list[str] = []
    for fp in file_paths:
        p = Path(fp).resolve()
        if not p.exists():
            notes.append(f"[Attached: {p.name} — FILE NOT FOUND at {p}]")
            continue

        ext = p.suffix.lower()
        size_mb = p.stat().st_size / (1024 * 1024)
        size_str = f"{size_mb:.1f} MB" if size_mb >= 0.1 else f"{p.stat().st_size} bytes"

        handler = _HANDLERS.get(ext, _handle_generic)
        note = handler(p, size_str)
        notes.append(note)

    return "\n".join(notes)


# ── Per-type handlers ────────────────────────────────────────────────────


def _handle_pdf(p: Path, size_str: str) -> str:
    """PDF: count pages, suggest read_pdf."""
    page_count = "?"
    try:
        import fitz
        with fitz.open(p) as doc:
            page_count = str(len(doc))
    except Exception:
        pass
    return (
        f"[Attached: {p.name} (PDF, {page_count} pages, {size_str})] "
        f"Path: {p}\n"
        f"Use `read_pdf` to explore this document."
    )


def _handle_csv(p: Path, size_str: str) -> str:
    """CSV: count rows + columns, list column names."""
    try:
        with p.open(newline="", errors="replace") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            row_count = sum(1 for _ in reader)  # count data rows
        if header:
            n_cols = len(header)
            cols_preview = ", ".join(header[:15])
            if n_cols > 15:
                cols_preview += f" … ({n_cols - 15} more)"
            return (
                f"[Attached: {p.name} (CSV, {row_count} rows x {n_cols} cols, {size_str})] "
                f"Path: {p}\n"
                f"Columns: {cols_preview}\n"
                f"Use `exec_command` with `python` (pandas is preinstalled) to explore this file."
            )
    except Exception:
        pass
    return (
        f"[Attached: {p.name} (CSV, {size_str})] Path: {p}\n"
        f"Use `exec_command` with `python` (pandas is preinstalled) to explore this file."
    )


def _handle_excel(p: Path, size_str: str) -> str:
    """XLSX/XLS: count sheets; openpyxl/pandas are preinstalled in the sandbox."""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(p, read_only=True)
        sheet_names = wb.sheetnames
        wb.close()
        sheets_str = f"{len(sheet_names)} sheets: {', '.join(sheet_names[:5])}"
    except Exception:
        sheets_str = "sheet count unknown"
    return (
        f"[Attached: {p.name} (Excel, {sheets_str}, {size_str})] "
        f"Path: {p}\n"
        f"Use `exec_command` with `python` (pandas and openpyxl are preinstalled) to explore this file."
    )


def _handle_json(p: Path, size_str: str) -> str:
    """JSON: count records, list top-level keys."""
    try:
        with p.open(errors="replace") as f:
            data = json.load(f)
        if isinstance(data, list):
            n = len(data)
            if n > 0 and isinstance(data[0], dict):
                keys = list(data[0].keys())[:10]
                key_str = ", ".join(keys)
                return (
                    f"[Attached: {p.name} (JSON, {n} records, {size_str})] "
                    f"Path: {p}\n"
                    f"Top keys: [{key_str}]\n"
                    f"Use `exec_command` with `python` (pandas is preinstalled) to explore, or "
                    f"`search_documents` if it's indexed."
                )
            return (
                f"[Attached: {p.name} (JSON array, {n} items, {size_str})] "
                f"Path: {p}\n"
                f"Use `exec_command` with `python` to explore this file."
            )
        elif isinstance(data, dict):
            keys = list(data.keys())[:10]
            key_str = ", ".join(keys)
            return (
                f"[Attached: {p.name} (JSON object, {size_str})] "
                f"Path: {p}\n"
                f"Top keys: [{key_str}]\n"
                f"Use `exec_command` with `python` to explore this file."
            )
    except Exception:
        pass
    return (
        f"[Attached: {p.name} (JSON, {size_str})] Path: {p}\n"
        f"Use `exec_command` with `python` to explore this file."
    )


def _handle_text(p: Path, size_str: str) -> str:
    """Text/Markdown: count lines, suggest read_file."""
    try:
        line_count = len(p.read_text(errors="replace").splitlines())
    except Exception:
        line_count = "?"
    return (
        f"[Attached: {p.name} (Text, {line_count} lines, {size_str})] "
        f"Path: {p}\n"
        f"Use `read_file` to view, or `search_documents` if indexed."
    )


def _handle_generic(p: Path, size_str: str) -> str:
    """Generic fallback for unsupported file types."""
    return (
        f"[Attached: {p.name} ({p.suffix or 'unknown'}, {size_str})] "
        f"Path: {p}\n"
        f"Use `read_file` to peek at content, or `exec_command` with `python` for binary formats."
    )


# Extension -> handler mapping
_HANDLERS = {
    ".pdf": _handle_pdf,
    ".csv": _handle_csv,
    ".xlsx": _handle_excel,
    ".xls": _handle_excel,
    ".json": _handle_json,
    ".txt": _handle_text,
    ".md": _handle_text,
    ".markdown": _handle_text,
}
