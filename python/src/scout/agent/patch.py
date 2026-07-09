"""Unified diff parser and applier for apply_patch tool."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class FilePatch:
    path: str
    new_content: bytes
    delete: bool = False


def parse_patch(patch_text: str, root: Path) -> list[FilePatch]:
    """Parse Codex freeform or unified diff patch text."""
    text = patch_text.strip()
    if "*** Begin Patch" in text or "*** Update File:" in text:
        return _parse_codex_patch(text, root)
    return parse_unified_patch(text, root)


def _parse_codex_patch(patch_text: str, root: Path) -> list[FilePatch]:
    root = root.resolve()
    results: list[FilePatch] = []
    blocks = re.split(r"\*\*\* (?:Begin Patch|End Patch)", patch_text)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            if line.startswith("*** Update File:"):
                rel = line.split(":", 1)[1].strip()
                i += 1
                body: list[str] = []
                while i < len(lines) and not lines[i].strip().startswith("*** "):
                    body.append(lines[i])
                    i += 1
                target = _resolve_patch_path(rel, root)
                old_text = target.read_text(encoding="utf-8") if target.exists() else ""
                new_text = _apply_codex_hunks(old_text, body)
                results.append(FilePatch(path=str(target), new_content=new_text.encode("utf-8")))
            elif line.startswith("*** Add File:"):
                rel = line.split(":", 1)[1].strip()
                i += 1
                content_lines: list[str] = []
                while i < len(lines) and not lines[i].strip().startswith("*** "):
                    l = lines[i]
                    if l.startswith("+"):
                        content_lines.append(l[1:])
                    elif not l.startswith("@@"):
                        content_lines.append(l)
                    i += 1
                target = _resolve_patch_path(rel, root)
                content = "\n".join(content_lines)
                if content and not content.endswith("\n"):
                    content += "\n"
                results.append(FilePatch(path=str(target), new_content=content.encode("utf-8")))
            elif line.startswith("*** Delete File:"):
                rel = line.split(":", 1)[1].strip()
                target = _resolve_patch_path(rel, root)
                results.append(FilePatch(path=str(target), new_content=b"", delete=True))
                i += 1
            else:
                i += 1
    if not results:
        raise ValueError("No valid file patches found in Codex patch text")
    return results


def _resolve_patch_path(rel: str, root: Path) -> Path:
    rel = rel.strip().lstrip("/")
    if rel.startswith("a/") or rel.startswith("b/"):
        rel = rel[2:]
    target = Path(rel)
    if not target.is_absolute():
        target = root / target
    target = target.resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"Patch path outside workspace: {rel}") from exc
    return target


def _apply_codex_hunks(original: str, hunk_lines: list[str]) -> str:
    if not hunk_lines or all(l.strip().startswith("@@") for l in hunk_lines if l.strip()):
        unified = "\n".join(
            l if l.startswith(("---", "+++", "@@", " ", "-", "+")) else f" {l}"
            for l in hunk_lines
        )
        if not unified.startswith("---"):
            unified = f"--- a/file\n+++ b/file\n{unified}"
        return _apply_hunks(original, unified.splitlines())
    out_lines = original.splitlines(keepends=True) if original else []
    if original and not original.endswith("\n"):
        out_lines = original.splitlines()
        out_lines = [l + "\n" for l in out_lines[:-1]] + ([out_lines[-1]] if out_lines else [])
    idx = 0
    result: list[str] = []
    for line in hunk_lines:
        if line.startswith("@@"):
            continue
        if line.startswith(" ") or (line and line[0] not in "+-"):
            content = line[1:] if line.startswith(" ") else line
            if idx < len(out_lines):
                result.append(out_lines[idx] if out_lines[idx].endswith("\n") else out_lines[idx] + "\n")
            else:
                result.append(content + ("\n" if not content.endswith("\n") else ""))
            idx += 1
        elif line.startswith("-"):
            idx += 1
        elif line.startswith("+"):
            content = line[1:]
            result.append(content + ("\n" if content and not content.endswith("\n") else ""))
    while idx < len(out_lines):
        result.append(out_lines[idx] if out_lines[idx].endswith("\n") else out_lines[idx] + "\n")
        idx += 1
    text = "".join(result)
    if original.endswith("\n") and text and not text.endswith("\n"):
        text += "\n"
    return text


def parse_unified_patch(patch_text: str, root: Path) -> list[FilePatch]:
    """Parse unified diff blocks into proposed file contents."""
    root = root.resolve()
    blocks = re.split(r"(?=^--- )", patch_text.strip(), flags=re.MULTILINE)
    results: list[FilePatch] = []

    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.splitlines()
        if not lines or not lines[0].startswith("--- "):
            continue

        old_line = lines[0][4:].strip()
        new_line = lines[1][4:].strip() if len(lines) > 1 and lines[1].startswith("+++ ") else old_line

        for raw in (new_line, old_line):
            path_str = raw.split("\t")[0].strip()
            if path_str.startswith("b/"):
                path_str = path_str[2:]
            elif path_str.startswith("a/"):
                path_str = path_str[2:]
            if path_str and path_str != "/dev/null":
                break
        else:
            continue

        target = Path(path_str)
        if not target.is_absolute():
            target = root / target
        target = target.resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise ValueError(f"Patch path outside workspace: {path_str}") from exc

        if old_line.endswith("/dev/null") or old_line.split("\t")[0].strip().endswith("/dev/null"):
            old_bytes: bytes | None = None
        else:
            old_bytes = target.read_bytes() if target.exists() else b""

        if new_line.endswith("/dev/null") or new_line.split("\t")[0].strip().endswith("/dev/null"):
            results.append(FilePatch(path=str(target), new_content=b"", delete=True))
            continue

        if old_bytes is None:
            old_text = ""
        else:
            try:
                old_text = old_bytes.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError(f"Binary file not supported in patch: {path_str}") from exc

        new_text = _apply_hunks(old_text, lines[2:])
        results.append(FilePatch(path=str(target), new_content=new_text.encode("utf-8")))

    if not results:
        raise ValueError("No valid file patches found in patch text")
    return results


def _apply_hunks(original: str, hunk_lines: list[str]) -> str:
    orig_lines = original.splitlines(keepends=True)
    if not orig_lines and original:
        orig_lines = [original]
    if original and not original.endswith("\n") and orig_lines:
        orig_lines[-1] = orig_lines[-1].rstrip("\n")

    out: list[str] = []
    idx = 0
    i = 0
    while i < len(hunk_lines):
        line = hunk_lines[i]
        if line.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            if m:
                idx = int(m.group(1)) - 1
            i += 1
            continue
        if line.startswith("---") or line.startswith("+++"):
            i += 1
            continue
        if line.startswith(" "):
            if idx < len(orig_lines):
                out.append(orig_lines[idx])
            idx += 1
        elif line.startswith("-"):
            idx += 1
        elif line.startswith("+"):
            out.append(line[1:] + ("\n" if not line[1:].endswith("\n") and line[1:] else ""))
            if not line[1:].endswith("\n") and line[1:]:
                out[-1] = line[1:]
        i += 1

    while idx < len(orig_lines):
        out.append(orig_lines[idx])
        idx += 1

    result = "".join(out)
    if original.endswith("\n") and result and not result.endswith("\n"):
        result += "\n"
    return result
