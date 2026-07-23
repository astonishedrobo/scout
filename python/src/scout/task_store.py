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

