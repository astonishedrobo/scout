"""Stage-2 global memory consolidation."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from ..config import MemoriesConfig
from ..memories import ensure_memory_layout, load_memory_registry, save_memory_registry, save_memory_summary
from ..memory_store import JOB_KIND_PHASE2, open_memory_store
from .guard import redact_secrets

logger = logging.getLogger(__name__)

_CONSOLIDATION_SYSTEM = """You maintain MEMORY.md and memory_summary.md from new session memories.
Return JSON: registry (full MEMORY.md markdown), summary (truncated bullets for prompt inject).

Apply a strict minimum-signal gate. Promote only memory that should change future agent behavior:
- stable user preferences or repeated steering,
- durable workspace/repo conventions,
- validated procedures, commands, paths, or failure shields.

Do not promote one-off document summaries, PDF metadata, page counts, titles, authors, dataset lists,
temporary analysis results, assistant follow-up suggestions, or generic task recaps. If new raw input
contains only those low-signal facts, keep existing registry/summary unchanged."""


async def _llm_consolidate(
    registry: str,
    raw_memories: str,
    summaries: str,
    app_config,
) -> dict[str, str]:
    try:
        import litellm
        import json
        model = app_config.agent.model
        prompt = f"Current MEMORY.md:\n{registry[:8000]}\n\nNew raw:\n{raw_memories[:8000]}\n\nSummaries:\n{summaries[:8000]}"
        resp = await litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _CONSOLIDATION_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        data = json.loads(resp.choices[0].message.content or "{}")
        return {
            "registry": str(data.get("registry", registry)),
            "summary": str(data.get("summary", "")),
        }
    except Exception as exc:
        logger.warning("Stage-2 LLM failed, sync-only: %s", exc)
        merged = registry.rstrip() + "\n\n" + raw_memories.strip()
        bullets = [l for l in raw_memories.splitlines() if l.strip().startswith("-")][:15]
        summary = "# Memory summary\n\n" + ("\n".join(bullets) if bullets else "_No memories yet._")
        return {"registry": merged, "summary": summary}


def _sync_artifacts(root: Path, outputs) -> tuple[str, str]:
    raw_lines: list[str] = ["# Raw memories", ""]
    summary_lines: list[str] = []
    summaries_dir = root / "rollout_summaries"
    summaries_dir.mkdir(parents=True, exist_ok=True)
    for out in outputs:
        raw_lines.append(f"## {out.thread_id}")
        raw_lines.append(out.raw_memory)
        raw_lines.append("")
        if out.rollout_summary:
            summary_lines.append(out.rollout_summary)
            slug = out.rollout_slug or out.thread_id[:8]
            (summaries_dir / f"{slug}.md").write_text(
                redact_secrets(out.rollout_summary) + "\n", encoding="utf-8",
            )
    raw_text = "\n".join(raw_lines)
    (root / "raw_memories.md").write_text(redact_secrets(raw_text) + "\n", encoding="utf-8")
    return raw_text, "\n\n".join(summary_lines)


async def run_stage2(
    *,
    personal_dir: Path,
    server_mode: bool,
    memories_config: MemoriesConfig,
    app_config,
    user_id: str = "default",
) -> bool:
    store = open_memory_store(personal_dir, server_mode)
    if not store.phase2_cooldown_ok():
        return False
    token = store.try_claim_job(JOB_KIND_PHASE2, "global")
    if token is None:
        return False

    try:
        root = ensure_memory_layout(user_id, personal_dir, server_mode)
        outputs = store.select_for_phase2(
            memories_config.phase2_top_n,
            memories_config.max_unused_days,
        )
        if not outputs:
            store.finish_job(JOB_KIND_PHASE2, "global", token, success=True)
            return False

        raw_text, summaries_blob = _sync_artifacts(root, outputs)
        registry = load_memory_registry(user_id, personal_dir, server_mode)
        consolidated = await _llm_consolidate(registry, raw_text, summaries_blob, app_config)
        save_memory_registry(redact_secrets(consolidated["registry"]), user_id, personal_dir, server_mode)
        if consolidated["summary"].strip():
            save_memory_summary(redact_secrets(consolidated["summary"]), user_id, personal_dir, server_mode)

        store.mark_selected_phase2([o.thread_id for o in outputs])
        store.finish_job(JOB_KIND_PHASE2, "global", token, success=True, watermark=int(time.time()))
        return True
    except Exception:
        logger.exception("Stage-2 consolidation failed")
        store.finish_job(JOB_KIND_PHASE2, "global", token, success=False)
        return False
