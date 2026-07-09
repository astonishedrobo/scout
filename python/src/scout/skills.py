"""Skill and layered instruction loader for the Scout agent.

Skills are markdown files that inject domain-specific expertise into the
system prompt.  Sources (lowest to highest precedence):

1. **Global skills:** ``~/.config/scout/skills/``
2. **Ancestor chain:** ``AGENTS.md``, ``SCOUT.md``, ``.scout/skills/*.md`` from
   project root → focus path (closer directories override earlier content)
3. **Project skills:** ``<project>/.scout/skills/`` at project root (legacy flat)
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_XDG_CONFIG = Path.home() / ".config" / "scout"
GLOBAL_SKILLS_DIR = _XDG_CONFIG / "skills"

_LAYERED_FILENAMES = ("AGENTS.md", "SCOUT.md")
_MAX_LAYER_CHARS = 4000


def _read_md_file(path: Path, label: str) -> str | None:
    try:
        content = path.read_text(encoding="utf-8").strip()
        if content:
            if len(content) > _MAX_LAYER_CHARS:
                content = content[:_MAX_LAYER_CHARS] + "\n\n… [truncated]"
            return f"### {label}\n\n{content}"
    except FileNotFoundError:
        return None
    except Exception as exc:
        logger.warning("Could not read %s: %s", path, exc)
    return None


def _collect_dir_layers(directory: Path, project_root: Path) -> list[str]:
    parts: list[str] = []
    try:
        rel = directory.resolve().relative_to(project_root.resolve())
        label_base = str(rel) if str(rel) != "." else "."
    except ValueError:
        label_base = str(directory)

    for fname in _LAYERED_FILENAMES:
        block = _read_md_file(directory / fname, f"{label_base}/{fname}")
        if block:
            parts.append(block)

    skills_dir = directory / ".scout" / "skills"
    if skills_dir.is_dir():
        for f in sorted(skills_dir.glob("*.md")):
            block = _read_md_file(f, f"{label_base}/.scout/skills/{f.name}")
            if block:
                parts.append(block)
    return parts


def _ancestor_chain(project_dir: Path, focus_path: Path | None) -> list[Path]:
    root = project_dir.resolve()
    if focus_path is None:
        return [root]
    focus = focus_path.resolve()
    try:
        focus.relative_to(root)
    except ValueError:
        return [root]

    chain: list[Path] = []
    current = focus if focus.is_dir() else focus.parent
    while True:
        chain.append(current)
        if current == root:
            break
        if root in current.parents:
            current = current.parent
        else:
            break
    chain.reverse()
    return chain


def load_layered_instructions(
    project_dir: Path | str | None,
    focus_path: Path | str | None = None,
    *,
    defer_skills: bool = False,
) -> str:
    """Load hierarchical AGENTS.md / SCOUT.md along root → focus.

    When defer_skills is True, inject skill index only (on-demand via skill_read).
    """
    from .skills_registry import discover_skills, format_skill_index

    global_parts: list[str] = []
    if not defer_skills and GLOBAL_SKILLS_DIR.is_dir():
        for f in sorted(GLOBAL_SKILLS_DIR.glob("*.md")):
            block = _read_md_file(f, f"global/{f.name}")
            if block:
                global_parts.append(block)

    if project_dir is None:
        if defer_skills:
            index = format_skill_index(discover_skills("."))
            if index:
                global_parts.append(f"### Available skills\n\n{index}\n\n_Use skill_read to load a skill body._")
        return "\n\n---\n\n".join(global_parts)

    root = Path(project_dir)
    focus = Path(focus_path) if focus_path else None
    layered: list[str] = []

    if defer_skills:
        for directory in _ancestor_chain(root, focus):
            try:
                rel = directory.resolve().relative_to(root.resolve())
                label_base = str(rel) if str(rel) != "." else "."
            except ValueError:
                label_base = str(directory)
            for fname in _LAYERED_FILENAMES:
                block = _read_md_file(directory / fname, f"{label_base}/{fname}")
                if block:
                    layered.append(block)
        index = format_skill_index(discover_skills(root, personal_dir=root))
        if index:
            layered.append(
                "### Available skills\n\n"
                f"{index}\n\n"
                "_Use skill_list / skill_read to load full SKILL.md bodies on demand._"
            )
    else:
        for directory in _ancestor_chain(root, focus):
            layered.extend(_collect_dir_layers(directory, root))
        project_skills = root / ".scout" / "skills"
        if project_skills.is_dir():
            for f in sorted(project_skills.glob("*.md")):
                block = _read_md_file(f, f".scout/skills/{f.name}")
                if block:
                    layered.append(block)

    all_parts = global_parts + layered
    if not all_parts:
        return ""

    result = "\n\n---\n\n".join(all_parts)
    logger.info(
        "Loaded %d instruction layer(s) (defer_skills=%s, focus=%s)",
        len(all_parts),
        defer_skills,
        focus_path or root,
    )
    return result


def load_skills(project_dir: Path | str | None = None) -> str:
    """Backward-compatible flat skill loader."""
    return load_layered_instructions(project_dir, focus_path=None)


def resolve_focus_path(
    project_dir: Path | str,
    attachment_paths: list[str] | None = None,
) -> Path | None:
    """Derive focus directory from @-attached file paths."""
    if not attachment_paths:
        return None
    root = Path(project_dir).resolve()
    dirs: list[Path] = []
    for raw in attachment_paths:
        p = Path(raw)
        if not p.is_absolute():
            p = root / p
        if p.exists():
            dirs.append(p.parent.resolve() if p.is_file() else p.resolve())

    if not dirs:
        return None

    try:
        common = Path(dirs[0])
        for d in dirs[1:]:
            common_parts = []
            for a, b in zip(common.parts, d.parts):
                if a == b:
                    common_parts.append(a)
                else:
                    break
            common = Path(*common_parts) if common_parts else root
        common.relative_to(root)
        return common if common != root else None
    except ValueError:
        return None
