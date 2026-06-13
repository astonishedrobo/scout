"""Stage-1 per-session memory extraction."""

from __future__ import annotations

import json
import logging
import time
import asyncio
from pathlib import Path

from ..config import MemoriesConfig
from ..memory_store import JOB_KIND_STAGE1, Stage1Output, open_memory_store
from .guard import redact_secrets

logger = logging.getLogger(__name__)

_STAGE1_SYSTEM = """You extract durable user preferences and workspace facts from a session transcript.
Output JSON with keys: raw_memory (bullet list), rollout_summary (2-4 sentences), rollout_slug (short-kebab)."""


def _session_mtime(path: Path) -> int:
    try:
        return int(path.stat().st_mtime)
    except OSError:
        return 0


def _eligible_sessions(
    sessions_dir: Path,
    *,
    idle_hours: float,
    max_age_days: int,
    exclude_thread_id: str | None = None,
) -> list[Path]:
    now = time.time()
    idle_cutoff = now - idle_hours * 3600
    age_cutoff = now - max_age_days * 86400
    candidates: list[tuple[float, Path]] = []
    if not sessions_dir.is_dir():
        return []
    for path in sessions_dir.glob("*.jsonl"):
        if path.stem == exclude_thread_id:
            continue
        mtime = _session_mtime(path)
        if mtime > idle_cutoff:
            continue
        if mtime < age_cutoff:
            continue
        candidates.append((mtime, path))
    candidates.sort(key=lambda x: x[0])
    return [p for _, p in candidates]


def _extract_messages(session_path: Path) -> str:
    lines = [l for l in session_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if len(lines) < 2:
        return ""
    parts: list[str] = []
    for line in lines[1:]:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        role = msg.get("type") or msg.get("role", "")
        if role not in {"user", "assistant"}:
            continue
        content = (msg.get("content") or "").strip()
        if content:
            parts.append(f"{role}: {content[:2000]}")
    return "\n".join(parts[-40:])


async def _llm_extract(transcript: str, config) -> dict[str, str]:
    """Mock-friendly extraction; uses LiteLLM when available."""
    if not transcript.strip():
        return {"raw_memory": "", "rollout_summary": "", "rollout_slug": ""}
    try:
        import litellm
        model = config.agent.model
        resp = await litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _STAGE1_SYSTEM},
                {"role": "user", "content": transcript[:12000]},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        text = resp.choices[0].message.content or "{}"
        data = json.loads(text)
        return {
            "raw_memory": str(data.get("raw_memory", "")),
            "rollout_summary": str(data.get("rollout_summary", "")),
            "rollout_slug": str(data.get("rollout_slug", ""))[:40],
        }
    except Exception as exc:
        logger.warning("Stage-1 LLM failed, using heuristic: %s", exc)
        bullets = []
        for line in transcript.splitlines()[:10]:
            if line.startswith("user:"):
                bullets.append(f"- {line[5:].strip()[:120]}")
        return {
            "raw_memory": "\n".join(bullets),
            "rollout_summary": transcript.splitlines()[-1][:200] if transcript else "",
            "rollout_slug": session_path_slug(transcript),
        }


def session_path_slug(text: str) -> str:
    import re
    words = re.findall(r"[a-z]{3,}", text.lower())[:3]
    return "-".join(words) or "session"


async def run_stage1_for_session(
    session_path: Path,
    *,
    personal_dir: Path,
    server_mode: bool,
    memories_config: MemoriesConfig,
    app_config,
) -> bool:
    store = open_memory_store(personal_dir, server_mode)
    thread_id = session_path.stem
    source_mtime = _session_mtime(session_path)
    existing = store.get_stage1(thread_id)
    if existing and existing.source_updated_at >= source_mtime:
        return False

    token = store.try_claim_job(JOB_KIND_STAGE1, thread_id)
    if token is None:
        return False

    try:
        transcript = redact_secrets(_extract_messages(session_path))
        extracted = await _llm_extract(transcript, app_config)
        raw = redact_secrets(extracted["raw_memory"])
        summary = redact_secrets(extracted["rollout_summary"])
        if not raw and not summary:
            store.finish_job(JOB_KIND_STAGE1, thread_id, token, success=True)
            return False
        store.upsert_stage1(Stage1Output(
            thread_id=thread_id,
            session_path=str(session_path),
            raw_memory=raw,
            rollout_summary=summary,
            rollout_slug=extracted.get("rollout_slug"),
            source_updated_at=source_mtime,
            generated_at=int(time.time()),
        ))
        store.finish_job(JOB_KIND_STAGE1, thread_id, token, success=True, watermark=source_mtime)
        return True
    except Exception:
        logger.exception("Stage-1 failed for %s", session_path)
        store.finish_job(
            JOB_KIND_STAGE1,
            thread_id,
            token,
            success=False,
            retry_backoff_seconds=memories_config.stage1_retry_backoff_seconds,
        )
        return False


async def run_stage1_batch(
    sessions_dir: Path,
    *,
    personal_dir: Path,
    server_mode: bool,
    memories_config: MemoriesConfig,
    app_config,
    exclude_thread_id: str | None = None,
) -> int:
    store = open_memory_store(personal_dir, server_mode)
    paths = _eligible_sessions(
        sessions_dir,
        idle_hours=memories_config.stage1_idle_hours,
        max_age_days=memories_config.stage1_max_age_days,
        exclude_thread_id=exclude_thread_id,
    )
    candidates = [(path.stem, _session_mtime(path)) for path in paths]
    actionable_limit = min(
        memories_config.stage1_scan_limit,
        memories_config.stage1_max_jobs_per_startup,
    )
    thread_ids = set(store.filter_stage1_candidates(candidates, limit=actionable_limit))
    selected = [path for path in paths if path.stem in thread_ids]
    semaphore = asyncio.Semaphore(max(1, memories_config.stage1_concurrency))

    async def run(path: Path) -> bool:
        async with semaphore:
            return await run_stage1_for_session(
                path,
                personal_dir=personal_dir,
                server_mode=server_mode,
                memories_config=memories_config,
                app_config=app_config,
            )

    results = await asyncio.gather(*(run(path) for path in selected))
    count = sum(results)
    pruned = store.prune(memories_config.max_unused_days)
    logger.info(
        "Memory stage-1 scan: scanned=%d eligible=%d claimed=%d changed=%d pruned=%d",
        len(paths), len(candidates), len(selected), count, pruned,
    )
    return count + pruned
