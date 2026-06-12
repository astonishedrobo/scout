"""Execution audit logging with persistent append-only store."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_AUDIT_DIR = Path.home() / ".config" / "scout" / "audit"
_AUDIT_DB = _AUDIT_DIR / "executions.db"


@dataclass
class ExecutionAuditEntry:
    execution_id: str
    user_id: str
    session_id: str
    runtime: str
    command_summary: str
    start_time: float
    end_time: float | None = None
    status: str = "started"
    error_category: str | None = None
    changed_paths: list[str] = field(default_factory=list)
    approval_outcome: str | None = None
    grant_ids: list[str] = field(default_factory=list)
    promotion_outcome: str | None = None
    resource_usage: dict[str, Any] = field(default_factory=dict)


class ExecutionAuditor:
    """Records execution metadata without logging secrets."""

    def __init__(self, db_path: Path | None = None) -> None:
        self._entries: list[ExecutionAuditEntry] = []
        self._metrics: dict[str, int] = {
            "worker_starts": 0,
            "worker_crashes": 0,
            "timeouts": 0,
            "denied_capabilities": 0,
            "cleanup_failures": 0,
            "promotion_conflicts": 0,
        }
        self._db_path = db_path or _AUDIT_DB
        self._init_db()

    def _init_db(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    execution_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    runtime TEXT NOT NULL,
                    command_summary TEXT,
                    start_time REAL NOT NULL,
                    end_time REAL,
                    status TEXT,
                    error_category TEXT,
                    changed_paths TEXT,
                    approval_outcome TEXT,
                    grant_ids TEXT,
                    promotion_outcome TEXT,
                    resource_usage TEXT
                )
                """
            )
            conn.commit()

    def _persist(self, entry: ExecutionAuditEntry) -> None:
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute(
                    """
                    INSERT INTO execution_audit (
                        execution_id, user_id, session_id, runtime, command_summary,
                        start_time, end_time, status, error_category, changed_paths,
                        approval_outcome, grant_ids, promotion_outcome, resource_usage
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry.execution_id,
                        entry.user_id,
                        entry.session_id,
                        entry.runtime,
                        entry.command_summary[:500],
                        entry.start_time,
                        entry.end_time,
                        entry.status,
                        entry.error_category,
                        json.dumps(entry.changed_paths),
                        entry.approval_outcome,
                        json.dumps(entry.grant_ids),
                        entry.promotion_outcome,
                        json.dumps(entry.resource_usage),
                    ),
                )
                conn.commit()
        except sqlite3.Error as exc:
            logger.warning("Failed to persist audit entry: %s", exc)

    def start(self, **kwargs: Any) -> ExecutionAuditEntry:
        entry = ExecutionAuditEntry(
            execution_id=kwargs["execution_id"],
            user_id=kwargs["user_id"],
            session_id=kwargs["session_id"],
            runtime=kwargs["runtime"],
            command_summary=kwargs.get("command_summary", ""),
            start_time=time.time(),
            grant_ids=list(kwargs.get("grant_ids", [])),
        )
        self._entries.append(entry)
        self._metrics["worker_starts"] += 1
        logger.info(
            "execution.start id=%s user=%s session=%s runtime=%s cmd=%s",
            entry.execution_id, entry.user_id, entry.session_id,
            entry.runtime, entry.command_summary[:120],
        )
        return entry

    def finish(
        self,
        entry: ExecutionAuditEntry,
        *,
        status: str,
        error_category: str | None = None,
        changed_paths: list[str] | None = None,
        approval_outcome: str | None = None,
        promotion_outcome: str | None = None,
        resource_usage: dict[str, Any] | None = None,
    ) -> None:
        entry.end_time = time.time()
        entry.status = status
        entry.error_category = error_category
        if changed_paths:
            entry.changed_paths = changed_paths
        if approval_outcome:
            entry.approval_outcome = approval_outcome
        if promotion_outcome:
            entry.promotion_outcome = promotion_outcome
        if resource_usage:
            entry.resource_usage = resource_usage
        if error_category == "timed_out":
            self._metrics["timeouts"] += 1
        elif error_category == "worker_crashed":
            self._metrics["worker_crashes"] += 1
        elif error_category == "capability_denied":
            self._metrics["denied_capabilities"] += 1
        elif error_category == "artifact_promotion_conflict":
            self._metrics["promotion_conflicts"] += 1
        self._persist(entry)
        logger.info(
            "execution.finish id=%s status=%s error=%s duration=%.2fs",
            entry.execution_id, status, error_category,
            (entry.end_time or time.time()) - entry.start_time,
        )

    @property
    def metrics(self) -> dict[str, int]:
        return dict(self._metrics)

    def recent(self, limit: int = 50) -> list[ExecutionAuditEntry]:
        if self._entries:
            return self._entries[-limit:]
        results: list[ExecutionAuditEntry] = []
        try:
            with sqlite3.connect(self._db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT execution_id, user_id, session_id, runtime, command_summary,
                           start_time, end_time, status, error_category, changed_paths,
                           approval_outcome, grant_ids, promotion_outcome, resource_usage
                    FROM execution_audit
                    ORDER BY id DESC LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            for row in reversed(rows):
                results.append(ExecutionAuditEntry(
                    execution_id=row[0],
                    user_id=row[1],
                    session_id=row[2],
                    runtime=row[3],
                    command_summary=row[4] or "",
                    start_time=row[5],
                    end_time=row[6],
                    status=row[7] or "unknown",
                    error_category=row[8],
                    changed_paths=json.loads(row[9] or "[]"),
                    approval_outcome=row[10],
                    grant_ids=json.loads(row[11] or "[]"),
                    promotion_outcome=row[12],
                    resource_usage=json.loads(row[13] or "{}"),
                ))
        except sqlite3.Error:
            pass
        return results[-limit:]
