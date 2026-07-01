"""Translation of stable workspace display paths for execution backends."""

from __future__ import annotations

import re
from pathlib import Path


def translate_workspace_paths(
    text: str,
    *,
    personal_root: Path,
    shared_root: Path | None,
    user_id: str,
) -> str:
    """Replace file-tool path aliases with roots visible to an executor."""
    personal = str(personal_root)
    shared = str(shared_root) if shared_root is not None else ""
    uid = re.escape(str(user_id))
    translated = text

    if shared:
        translated = re.sub(
            r"(?<![\w/.-])/(?:app/)?workspace/shared(?=/|\s|$)",
            shared,
            translated,
        )
        translated = re.sub(
            r"(?<![\w/.-])workspace/shared(?=/|\s|$)", shared, translated,
        )
        translated = re.sub(
            r"(?<![\w/.-])shared(?=/|\s|$)", shared, translated,
        )

    translated = re.sub(
        rf"(?<![\w/.-])/(?:app/)?workspace/users/{uid}(?=/|\s|$)",
        personal,
        translated,
    )
    translated = re.sub(
        rf"(?<![\w/.-])workspace/users/{uid}(?=/|\s|$)", personal, translated,
    )
    translated = re.sub(
        r"(?<![\w/.-])/(?:app/)?workspace(?=/|\s|$)", personal, translated,
    )
    translated = re.sub(
        r"(?<![\w/.-])workspace(?=/|\s|$)", personal, translated,
    )
    return translated
