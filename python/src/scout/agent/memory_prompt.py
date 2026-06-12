"""Codex-style memory read-path developer instructions."""

from __future__ import annotations

READ_PATH_TEMPLATE = """## Memory

You have access to a memory folder with guidance from prior runs. Use it when it helps.

Decision boundary:
- Skip memory for self-contained requests (time/date, trivial rewrite, one-line command).
- Use memory when the query references workspace history, conventions, prior decisions, or items in MEMORY_SUMMARY below.

Memory layout:
- {base_path}/memory_summary.md (provided below — do NOT re-open)
- {base_path}/MEMORY.md (search with memory_search)
- {base_path}/rollout_summaries/
- {base_path}/skills/
- {base_path}/extensions/ad_hoc/notes/ (user-requested updates only)

Quick memory pass:
1. Skim MEMORY_SUMMARY below.
2. memory_search keywords in MEMORY.md.
3. memory_read only the 1-2 most relevant files.
4. Keep lookup lightweight (<= 6 steps).

Memory citations: if memory files were used, append exactly one block at the VERY END:

<scout-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[how used]
</citation_entries>
<rollout_ids>
session-uuid-here
</rollout_ids>
</scout-mem-citation>

Updating memories: only when the user explicitly asks — use memory_add_note.

========= MEMORY_SUMMARY BEGINS =========
{memory_summary}
========= MEMORY_SUMMARY ENDS =========
"""


def build_memory_instructions(base_path: str, memory_summary: str) -> str:
    if not memory_summary.strip():
        return ""
    return READ_PATH_TEMPLATE.format(
        base_path=base_path,
        memory_summary=memory_summary.strip(),
    )
