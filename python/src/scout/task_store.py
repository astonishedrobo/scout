"""Durable, ordered task lifecycle storage for a Scout session."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


class TaskStore:
    """Small SQLite journal; task updates and replay events commit together."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
              task_id TEXT PRIMARY KEY, task_type TEXT NOT NULL, title TEXT NOT NULL,
              status TEXT NOT NULL, created_at REAL, started_at REAL, finished_at REAL,
              summary TEXT, result_preview TEXT, error TEXT, updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
              created_at REAL NOT NULL, payload TEXT NOT NULL
            );
        """)
        self._conn.commit()

    def upsert(self, task: dict[str, Any]) -> tuple[dict[str, Any], int]:
        now = time.time()
        record = {**task, "updated_at": now}
        with self._lock:
            self._conn.execute("""
              INSERT INTO tasks(task_id,task_type,title,status,created_at,started_at,finished_at,summary,result_preview,error,updated_at)
              VALUES(:task_id,:task_type,:title,:status,:created_at,:started_at,:finished_at,:summary,:result_preview,:error,:updated_at)
              ON CONFLICT(task_id) DO UPDATE SET task_type=excluded.task_type,title=excluded.title,status=excluded.status,
                created_at=COALESCE(excluded.created_at,tasks.created_at),started_at=COALESCE(excluded.started_at,tasks.started_at),
                finished_at=excluded.finished_at,summary=excluded.summary,result_preview=excluded.result_preview,error=excluded.error,updated_at=excluded.updated_at
            """, {key: record.get(key) for key in ("task_id","task_type","title","status","created_at","started_at","finished_at","summary","result_preview","error","updated_at")})
            cursor = self._conn.execute("INSERT INTO task_events(task_id,created_at,payload) VALUES(?,?,?)", (record["task_id"], now, json.dumps(record)))
            self._conn.commit()
            return record, int(cursor.lastrowid)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._conn.execute("SELECT task_id,task_type,title,status,created_at,started_at,finished_at,summary,result_preview,error FROM tasks ORDER BY updated_at DESC")]

    def interrupt_orphaned_running(self) -> list[dict[str, Any]]:
        """Close tasks which cannot survive a Scout server restart.

        A new in-memory session has no monitor attached to an old process.  A
        stale 'running' badge is worse than an explicit interruption, and the
        durable event lets the UI explain why it changed.
        """
        with self._lock:
            rows = list(self._conn.execute(
                "SELECT task_id,task_type,title,created_at,started_at FROM tasks WHERE status IN ('queued', 'running')"
            ))
        records: list[dict[str, Any]] = []
        now = time.time()
        for row in rows:
            record, _ = self.upsert({
                **dict(row), "status": "interrupted", "finished_at": now,
                "summary": "Interrupted because Scout restarted",
                "result_preview": None,
                "error": "Task monitor was not available after restart",
            })
            records.append(record)
        return records
