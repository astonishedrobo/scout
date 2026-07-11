"""Codex-style memory read-path developer instructions."""

from __future__ import annotations

READ_PATH_TEMPLATE = """## Memory

You have one user memory file. Use it when it helps.

Decision boundary:
- Skip memory for self-contained requests (time/date, trivial rewrite, one-line command).
- Use memory when the query references user preferences, workspace history, conventions, or prior decisions.
- Do not say memory is unknown if the answer is present in MEMORY.md below.

Memory file:
- {base_path}/MEMORY.md

Current MEMORY.md:
{memory_content}

Lookup guidance:
- The MEMORY.md content above is authoritative.
- If the user asks about remembered information, answer from it directly.
- Use memory_search or memory_read only if you need to inspect the file again.

Memory citations (machine-only): if memory files were used, append exactly one
complete block at the VERY END of your final answer, after all user-facing prose.
The harness strips the whole block — never put any of these tags mid-message, and
never emit partial fragments such as bare `<citation_entries>` without the outer
`<scout-mem-citation>` wrapper.

<scout-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[how used]
</citation_entries>
</scout-mem-citation>

Paths in MEMORY.md may use older forms such as workspace/shared/... — prefer the
canonical agent paths /shared/... and /workspace/... when calling tools.

Updating memories: only when the user explicitly asks — use memory_add_note. It writes to MEMORY.md.
"""


def _has_memory_entries(memory_content: str) -> bool:
    for line in memory_content.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            return True
    return False


def build_memory_instructions(base_path: str, memory_content: str) -> str:
    if not _has_memory_entries(memory_content):
        return ""
    return READ_PATH_TEMPLATE.format(
        base_path=base_path,
        memory_content=memory_content.strip(),
    )
