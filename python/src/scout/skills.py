"""Skill loader for the Scout agent.

Skills are markdown files that inject domain-specific expertise into the
system prompt.  They are loaded from two locations:

1. **Global skills:** ``~/.config/scout/skills/``
2. **Project skills:** ``<project>/.scout/skills/``

Project-level skills with the same filename as a global skill replace
the global one (project wins).  Skills are sorted alphabetically by
stem name and concatenated with ``---`` separators.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_XDG_CONFIG = Path.home() / ".config" / "scout"
GLOBAL_SKILLS_DIR = _XDG_CONFIG / "skills"


def load_skills(project_dir: Path | str | None = None) -> str:
    """Load and merge skill files from global and project directories.

    Parameters
    ----------
    project_dir : Path | str | None
        Root of the project (the dir containing ``.scout/``).
        If ``None``, only global skills are loaded.

    Returns
    -------
    str
        Concatenated skill text (empty string if no skills found).
    """
    skills: dict[str, str] = {}  # stem -> content (project overrides global)

    dirs_to_scan: list[Path] = [GLOBAL_SKILLS_DIR]
    if project_dir is not None:
        project_skills = Path(project_dir) / ".scout" / "skills"
        dirs_to_scan.append(project_skills)

    for d in dirs_to_scan:
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            try:
                content = f.read_text(encoding="utf-8").strip()
                if content:
                    skills[f.stem] = content
                    logger.debug("Loaded skill: %s from %s", f.stem, d)
            except Exception as exc:
                logger.warning("Could not read skill file %s: %s", f, exc)

    if not skills:
        return ""

    # Sort by name for deterministic ordering
    ordered = [skills[name] for name in sorted(skills)]
    result = "\n\n---\n\n".join(ordered)
    logger.info("Loaded %d skill(s)", len(skills))
    return result
