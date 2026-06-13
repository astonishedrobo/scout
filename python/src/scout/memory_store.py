"""SQLite store for Codex-style memory pipeline jobs and stage-1 outputs."""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
JOB_KIND_STAGE1 = "memory_stage1"
JOB_KIND_PHASE2 = "memory_consolidate_global"
DEFAULT_LEASE_SECONDS = 300
DEFAULT_RETRY_REMAINING = 3


@dataclass
class Stage1Output:
    thread_id: str
    session_path: str
    raw_memory: str
    rollout_summary: str
    rollout_slug: str | None
    source_updated_at: int
    generated_at: int
    usage_count: int = 0
    last_usage: int | None = None
    selected_for_phase2: bool = False


class MemoryStore:
    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS stage1_outputs (
                thread_id TEXT PRIMARY KEY,
                session_path TEXT NOT NULL,
                raw_memory TEXT NOT NULL,
                rollout_summary TEXT NOT NULL,
                rollout_slug TEXT,
                source_updated_at INTEGER NOT NULL,
                generated_at INTEGER NOT NULL,
                usage_count INTEGER DEFAULT 0,
                last_usage INTEGER,
                selected_for_phase2 INTEGER DEFAULT 0,
                selected_source_updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS memory_jobs (
                kind TEXT NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                lease_until INTEGER,
                ownership_token TEXT,
                retry_remaining INTEGER DEFAULT 3,
                retry_after INTEGER,
                last_success_watermark INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (kind, job_key)
            );
            """
        )
        columns = {
            row["name"] for row in self._conn.execute("PRAGMA table_info(memory_jobs)").fetchall()
        }
        if "retry_after" not in columns:
            self._conn.execute("ALTER TABLE memory_jobs ADD COLUMN retry_after INTEGER")
        self._conn.commit()

    def filter_stage1_candidates(
        self,
        candidates: list[tuple[str, int]],
        *,
        limit: int,
    ) -> list[str]:
        """Return candidates that need model processing and can currently be claimed."""
        now = int(time.time())
        selected: list[str] = []
        for thread_id, source_updated_at in candidates:
            output = self._conn.execute(
                "SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
            job = self._conn.execute(
                """
                SELECT status, lease_until, retry_remaining, retry_after, last_success_watermark
                FROM memory_jobs WHERE kind = ? AND job_key = ?
                """,
                (JOB_KIND_STAGE1, thread_id),
            ).fetchone()
            watermark = int(job["last_success_watermark"] or 0) if job else 0
            output_watermark = int(output["source_updated_at"]) if output else 0
            if max(watermark, output_watermark) >= source_updated_at:
                continue
            if job:
                if job["status"] == "running" and int(job["lease_until"] or 0) > now:
                    continue
                if job["status"] == "failed" and (
                    int(job["retry_remaining"] or 0) <= 0
                    or int(job["retry_after"] or 0) > now
                ):
                    continue
            selected.append(thread_id)
            if len(selected) >= limit:
                break
        return selected

    def upsert_stage1(self, output: Stage1Output) -> None:
        self._conn.execute(
            """
            INSERT INTO stage1_outputs (
                thread_id, session_path, raw_memory, rollout_summary, rollout_slug,
                source_updated_at, generated_at, usage_count, last_usage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                session_path=excluded.session_path,
                raw_memory=excluded.raw_memory,
                rollout_summary=excluded.rollout_summary,
                rollout_slug=excluded.rollout_slug,
                source_updated_at=excluded.source_updated_at,
                generated_at=excluded.generated_at
            """,
            (
                output.thread_id,
                output.session_path,
                output.raw_memory,
                output.rollout_summary,
                output.rollout_slug,
                output.source_updated_at,
                output.generated_at,
                output.usage_count,
                output.last_usage,
            ),
        )
        self._conn.commit()

    def get_stage1(self, thread_id: str) -> Stage1Output | None:
        row = self._conn.execute(
            "SELECT * FROM stage1_outputs WHERE thread_id = ?", (thread_id,),
        ).fetchone()
        if row is None:
            return None
        return _row_to_stage1(row)

    def record_usage(self, thread_ids: list[str]) -> int:
        if not thread_ids:
            return 0
        now = int(time.time())
        updated = 0
        for tid in thread_ids:
            cur = self._conn.execute(
                """
                UPDATE stage1_outputs
                SET usage_count = COALESCE(usage_count, 0) + 1, last_usage = ?
                WHERE thread_id = ?
                """,
                (now, tid),
            )
            updated += cur.rowcount
        self._conn.commit()
        return updated

    def select_for_phase2(self, top_n: int, max_unused_days: int) -> list[Stage1Output]:
        cutoff = int(time.time()) - max_unused_days * 86400
        rows = self._conn.execute(
            """
            SELECT * FROM stage1_outputs
            WHERE (last_usage IS NULL OR last_usage >= ?)
               OR (last_usage IS NULL AND generated_at >= ?)
            ORDER BY COALESCE(usage_count, 0) DESC,
                     COALESCE(last_usage, generated_at) DESC
            LIMIT ?
            """,
            (cutoff, cutoff, top_n),
        ).fetchall()
        return [_row_to_stage1(r) for r in rows]

    def mark_selected_phase2(self, thread_ids: list[str]) -> None:
        self._conn.execute(
            "UPDATE stage1_outputs SET selected_for_phase2 = 0",
        )
        for tid in thread_ids:
            self._conn.execute(
                "UPDATE stage1_outputs SET selected_for_phase2 = 1 WHERE thread_id = ?",
                (tid,),
            )
        self._conn.commit()

    def try_claim_job(
        self,
        kind: str,
        job_key: str,
        *,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> str | None:
        now = int(time.time())
        token = str(uuid.uuid4())
        self._conn.execute("BEGIN IMMEDIATE")
        row = self._conn.execute(
            "SELECT * FROM memory_jobs WHERE kind = ? AND job_key = ?",
            (kind, job_key),
        ).fetchone()
        if row is None:
            self._conn.execute(
                """
                INSERT INTO memory_jobs (kind, job_key, status, lease_until, ownership_token, updated_at)
                VALUES (?, ?, 'running', ?, ?, ?)
                """,
                (kind, job_key, now + lease_seconds, token, now),
            )
            self._conn.commit()
            return token
        lease_until = row["lease_until"] or 0
        status = row["status"]
        if status == "running" and lease_until > now:
            self._conn.rollback()
            return None
        retry = row["retry_remaining"] or 0
        if status == "failed" and (
            retry <= 0 or int(row["retry_after"] or 0) > now
        ):
            self._conn.rollback()
            return None
        self._conn.execute(
            """
            UPDATE memory_jobs
            SET status = 'running', lease_until = ?, ownership_token = ?, updated_at = ?
            WHERE kind = ? AND job_key = ?
            """,
            (now + lease_seconds, token, now, kind, job_key),
        )
        self._conn.commit()
        return token

    def finish_job(
        self,
        kind: str,
        job_key: str,
        token: str,
        *,
        success: bool,
        watermark: int | None = None,
        retry_backoff_seconds: int = 3600,
    ) -> None:
        now = int(time.time())
        row = self._conn.execute(
            "SELECT ownership_token, retry_remaining FROM memory_jobs WHERE kind = ? AND job_key = ?",
            (kind, job_key),
        ).fetchone()
        if row is None or row["ownership_token"] != token:
            return
        retry = row["retry_remaining"] or DEFAULT_RETRY_REMAINING
        if success:
            self._conn.execute(
                """
                UPDATE memory_jobs
                SET status = 'succeeded', lease_until = NULL, ownership_token = NULL,
                    retry_after = NULL, last_success_watermark = ?, updated_at = ?,
                    retry_remaining = ?
                WHERE kind = ? AND job_key = ?
                """,
                (watermark or now, now, DEFAULT_RETRY_REMAINING, kind, job_key),
            )
        else:
            self._conn.execute(
                """
                UPDATE memory_jobs
                SET status = 'failed', lease_until = NULL, ownership_token = NULL,
                    retry_after = ?, updated_at = ?, retry_remaining = ?
                WHERE kind = ? AND job_key = ?
                """,
                (now + retry_backoff_seconds, now, max(0, retry - 1), kind, job_key),
            )
        self._conn.commit()

    def prune(self, max_unused_days: int) -> int:
        cutoff = int(time.time()) - max_unused_days * 86400
        cur = self._conn.execute(
            """
            DELETE FROM stage1_outputs
            WHERE COALESCE(last_usage, generated_at) < ?
            """,
            (cutoff,),
        )
        self._conn.execute(
            """
            DELETE FROM memory_jobs
            WHERE kind = ? AND status != 'running' AND updated_at < ?
              AND job_key NOT IN (SELECT thread_id FROM stage1_outputs)
            """,
            (JOB_KIND_STAGE1, cutoff),
        )
        self._conn.commit()
        return cur.rowcount

    def phase2_cooldown_ok(self, cooldown_seconds: int = 6 * 3600) -> bool:
        row = self._conn.execute(
            "SELECT last_success_watermark FROM memory_jobs WHERE kind = ? AND job_key = ?",
            (JOB_KIND_PHASE2, "global"),
        ).fetchone()
        if row is None or row["last_success_watermark"] is None:
            return True
        return int(time.time()) - row["last_success_watermark"] >= cooldown_seconds

    def close(self) -> None:
        self._conn.close()


def memory_db_path(
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> Path:
    if server_mode and personal_dir:
        return Path(personal_dir) / ".scout" / "memory.db"
    return Path.home() / ".config" / "scout" / "memory.db"


def open_memory_store(
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> MemoryStore:
    return MemoryStore(memory_db_path(personal_dir, server_mode))


def _row_to_stage1(row: sqlite3.Row) -> Stage1Output:
    return Stage1Output(
        thread_id=row["thread_id"],
        session_path=row["session_path"],
        raw_memory=row["raw_memory"],
        rollout_summary=row["rollout_summary"],
        rollout_slug=row["rollout_slug"],
        source_updated_at=row["source_updated_at"],
        generated_at=row["generated_at"],
        usage_count=row["usage_count"] or 0,
        last_usage=row["last_usage"],
        selected_for_phase2=bool(row["selected_for_phase2"]),
    )
