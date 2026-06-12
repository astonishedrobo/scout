"""Skill registry — index SKILL.md files without injecting full bodies."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_XDG_CONFIG = Path.home() / ".config" / "scout"
_GLOBAL_SKILLS = _XDG_CONFIG / "skills"
_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


@dataclass(frozen=True)
class SkillEntry:
    name: str
    description: str
    path: str


def _parse_frontmatter(text: str) -> tuple[str, str]:
    m = _FRONTMATTER.match(text)
    if not m:
        return ("", text.strip())
    body = text[m.end() :].strip()
    meta = m.group(1)
    name = ""
    desc = ""
    for line in meta.splitlines():
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip().strip('"').strip("'")
        elif line.startswith("description:"):
            desc = line.split(":", 1)[1].strip().strip('"').strip("'")
    return (name, desc or body[:120])


def _scan_skill_dirs(*roots: Path) -> list[SkillEntry]:
    entries: list[SkillEntry] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for skill_md in sorted(root.rglob("SKILL.md")):
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            name, desc = _parse_frontmatter(text)
            if not name:
                name = skill_md.parent.name
            key = str(skill_md.resolve())
            if key in seen:
                continue
            seen.add(key)
            entries.append(SkillEntry(name=name, description=desc, path=str(skill_md)))
    return entries


def discover_skills(
    data_dir: str | Path,
    *,
    personal_dir: Path | str | None = None,
    memory_skills_dir: Path | None = None,
) -> list[SkillEntry]:
    data = Path(data_dir).resolve()
    roots: list[Path] = []
    if _GLOBAL_SKILLS.is_dir():
        roots.append(_GLOBAL_SKILLS)
    project_skills = data / ".scout" / "skills"
    if project_skills.is_dir():
        roots.append(project_skills)
    if personal_dir:
        personal = Path(personal_dir)
        mem_skills = memory_skills_dir or (personal / ".scout" / "memories" / "skills")
        if mem_skills.is_dir():
            roots.append(mem_skills)
    return _scan_skill_dirs(*roots)


def format_skill_index(entries: list[SkillEntry]) -> str:
    if not entries:
        return ""
    lines = ["| name | description | path |", "| --- | --- | --- |"]
    for e in entries:
        lines.append(f"| {e.name} | {e.description[:80]} | {e.path} |")
    return "\n".join(lines)


def list_skills(
    data_dir: str | Path,
    *,
    personal_dir: Path | str | None = None,
) -> str:
    entries = discover_skills(data_dir, personal_dir=personal_dir)
    if not entries:
        return "(no skills found)"
    return format_skill_index(entries)


def read_skill(path: str, data_dir: str | Path, *, personal_dir: Path | str | None = None) -> str:
    p = Path(path).resolve()
    allowed_roots = [Path(data_dir).resolve(), _GLOBAL_SKILLS.resolve()]
    if personal_dir:
        allowed_roots.append(Path(personal_dir).resolve())
    for root in allowed_roots:
        try:
            p.relative_to(root)
            break
        except ValueError:
            continue
    else:
        return f"[Invalid skill path: {path}]"
    if not p.exists():
        return f"[Not found: {path}]"
    try:
        return p.read_text(encoding="utf-8")
    except OSError as exc:
        return f"[Read error: {exc}]"
