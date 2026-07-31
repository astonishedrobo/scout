"""Scheduled tasks: durable storage, schedule math, and public record shape.

A scheduled task is:
  instruction (prompt) + schedule/trigger + linked session + status.

The server polls for due tasks and executes each instruction in the task's
conversation. This module stays free of FastAPI / agent imports so tests can
cover schedule math without the full stack.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

MIN_INTERVAL_MINUTES = 60
MAX_ACTIVE_TASKS = 15
# How late a due slot may still fire. Past this, the poller skips (no catch-up).
MISS_GRACE_SECONDS = 15 * 60
MISS_ERROR = "Missed scheduled run"

WEEKDAY_NAMES = {
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tues": 1,
    "tuesday": 1,
    "wed": 2,
    "wednesday": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
    "sun": 6,
    "sunday": 6,
}


class ScheduleError(ValueError):
    """Invalid schedule specification from the client."""


@dataclass(frozen=True)
class ScheduleSpec:
    """Normalized schedule. Stored as JSON in the task row."""

    kind: str  # once | interval | daily | weekly
    timezone: str = "UTC"  # IANA; client must supply the user's zone for wall-clock kinds
    # once
    run_at: str | None = None  # ISO-8601 (absolute; timezone is for display/labels)
    # interval
    interval_minutes: int | None = None
    # daily / weekly
    time: str | None = None  # HH:MM (24h, in schedule.timezone)
    weekdays: tuple[int, ...] | None = None  # 0=Mon .. 6=Sun

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "timezone": self.timezone,
            "run_at": self.run_at,
            "interval_minutes": self.interval_minutes,
            "time": self.time,
            "weekdays": list(self.weekdays) if self.weekdays is not None else None,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> ScheduleSpec:
        if not raw or not isinstance(raw, dict):
            raise ScheduleError("schedule is required")
        kind = str(raw.get("kind") or "").strip().lower()
        if kind not in {"once", "interval", "daily", "weekly"}:
            raise ScheduleError("schedule.kind must be once, interval, daily, or weekly")
        tz = str(raw.get("timezone") or "UTC").strip() or "UTC"
        try:
            ZoneInfo(tz)
        except Exception as exc:
            raise ScheduleError(f"unknown timezone: {tz}") from exc

        run_at = raw.get("run_at")
        interval_minutes = raw.get("interval_minutes")
        time_str = raw.get("time")
        weekdays_raw = raw.get("weekdays")

        if kind == "once":
            if not run_at:
                raise ScheduleError("once schedule requires run_at")
            # Validate parse
            _parse_iso(str(run_at))
            return cls(kind=kind, timezone=tz, run_at=str(run_at))

        if kind == "interval":
            try:
                minutes = int(interval_minutes)
            except (TypeError, ValueError) as exc:
                raise ScheduleError("interval schedule requires interval_minutes") from exc
            if minutes < MIN_INTERVAL_MINUTES:
                raise ScheduleError(
                    f"interval must be at least {MIN_INTERVAL_MINUTES} minutes"
                )
            return cls(kind=kind, timezone=tz, interval_minutes=minutes)

        if not time_str or not re.fullmatch(r"\d{1,2}:\d{2}", str(time_str)):
            raise ScheduleError("daily/weekly schedule requires time as HH:MM")
        hour, minute = (int(x) for x in str(time_str).split(":"))
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ScheduleError("time must be a valid HH:MM")
        normalized_time = f"{hour:02d}:{minute:02d}"

        if kind == "daily":
            return cls(kind=kind, timezone=tz, time=normalized_time)

        if weekdays_raw is None:
            raise ScheduleError("weekly schedule requires weekdays")
        weekdays: list[int] = []
        for item in weekdays_raw:
            try:
                day = int(item)
            except (TypeError, ValueError) as exc:
                raise ScheduleError("weekdays must be integers 0-6 (Mon-Sun)") from exc
            if day < 0 or day > 6:
                raise ScheduleError("weekdays must be integers 0-6 (Mon-Sun)")
            weekdays.append(day)
        if not weekdays:
            raise ScheduleError("weekly schedule requires at least one weekday")
        return cls(
            kind=kind,
            timezone=tz,
            time=normalized_time,
            weekdays=tuple(sorted(set(weekdays))),
        )


def _parse_iso(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def compute_next_run(
    schedule: ScheduleSpec,
    *,
    after: datetime | None = None,
    first: bool = False,
) -> datetime | None:
    """Return the next UTC fire time at or after ``after`` (default: now).

    For ``once``, returns the run_at if it is still in the future (or equal),
    else None. For recurring kinds, always returns a future (or equal) time.
    When ``first`` is True and kind is interval, fire after one full interval
    from now rather than immediately.
    """
    after = (after or _now_utc()).astimezone(timezone.utc)
    tz = ZoneInfo(schedule.timezone)

    if schedule.kind == "once":
        assert schedule.run_at
        run_at = _parse_iso(schedule.run_at)
        return run_at if run_at >= after - timedelta(seconds=1) else None

    if schedule.kind == "interval":
        assert schedule.interval_minutes
        delta = timedelta(minutes=schedule.interval_minutes)
        if first:
            return after + delta
        # Next boundary: after + full interval (caller uses last_run as after)
        return after + delta

    assert schedule.time
    hour, minute = (int(x) for x in schedule.time.split(":"))
    local_after = after.astimezone(tz)

    def candidate_on(day: datetime) -> datetime:
        local = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return local.astimezone(timezone.utc)

    if schedule.kind == "daily":
        cand = candidate_on(local_after)
        if cand >= after:
            return cand
        return candidate_on(local_after + timedelta(days=1))

    assert schedule.weekdays
    # Search up to 8 days ahead for the next matching weekday.
    for offset in range(0, 8):
        day = local_after + timedelta(days=offset)
        if day.weekday() not in schedule.weekdays:
            continue
        cand = candidate_on(day)
        if cand >= after:
            return cand
    # Should be unreachable
    return candidate_on(local_after + timedelta(days=7))


def schedule_label(schedule: ScheduleSpec) -> str:
    """Human-readable schedule for the UI."""
    if schedule.kind == "once":
        assert schedule.run_at
        dt = _parse_iso(schedule.run_at).astimezone(ZoneInfo(schedule.timezone))
        return f"Once · {dt.strftime('%b %d · %I:%M %p').replace(' 0', ' ')} ({schedule.timezone})"
    if schedule.kind == "interval":
        mins = schedule.interval_minutes or 0
        if mins % 1440 == 0:
            days = mins // 1440
            return f"Every {days} day{'s' if days != 1 else ''}"
        if mins % 60 == 0:
            hours = mins // 60
            return f"Every {hours} hour{'s' if hours != 1 else ''}"
        return f"Every {mins} minutes"
    if schedule.kind == "daily":
        return f"Daily at {schedule.time} ({schedule.timezone})"
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    days = ", ".join(names[d] for d in (schedule.weekdays or ()))
    return f"{days} at {schedule.time} ({schedule.timezone})"


def parse_natural_schedule(
    text: str,
    *,
    timezone_name: str = "UTC",
    now: datetime | None = None,
) -> tuple[str, ScheduleSpec] | None:
    """Best-effort parse of a short natural-language schedule phrase.

    Returns (instruction_without_schedule, schedule) or None if no schedule
    fragment is recognized. Keeps the instruction usable even when partial.
    """
    raw = text.strip()
    if not raw:
        return None
    now = now or _now_utc()
    lower = raw.lower()

    # "in N minutes/hours/days"
    m = re.search(
        r"\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b",
        lower,
    )
    if m:
        amount = int(m.group(1))
        unit = m.group(2)
        if unit.startswith("min"):
            delta = timedelta(minutes=amount)
        elif unit.startswith("hour") or unit.startswith("hr"):
            delta = timedelta(hours=amount)
        else:
            delta = timedelta(days=amount)
        run_at = (now + delta).astimezone(timezone.utc).isoformat()
        instruction = re.sub(
            r"\bin\s+\d+\s*(minutes?|mins?|hours?|hrs?|days?)\b",
            "",
            raw,
            flags=re.IGNORECASE,
        )
        instruction = _clean_instruction(instruction)
        return instruction, ScheduleSpec(kind="once", timezone=timezone_name, run_at=run_at)

    # "every N hours/days"
    m = re.search(r"\bevery\s+(\d+)\s*(hours?|hrs?|days?)\b", lower)
    if m:
        amount = int(m.group(1))
        unit = m.group(2)
        minutes = amount * (60 if unit.startswith("h") else 1440)
        if minutes < MIN_INTERVAL_MINUTES:
            minutes = MIN_INTERVAL_MINUTES
        instruction = re.sub(
            r"\bevery\s+\d+\s*(hours?|hrs?|days?)\b",
            "",
            raw,
            flags=re.IGNORECASE,
        )
        return (
            _clean_instruction(instruction),
            ScheduleSpec(kind="interval", timezone=timezone_name, interval_minutes=minutes),
        )

    # "every hour"
    if re.search(r"\bevery\s+hour\b", lower):
        instruction = re.sub(r"\bevery\s+hour\b", "", raw, flags=re.IGNORECASE)
        return (
            _clean_instruction(instruction),
            ScheduleSpec(kind="interval", timezone=timezone_name, interval_minutes=60),
        )

    # "every day/morning/evening at HH:MM" or "daily at ..."
    m = re.search(
        r"\b(?:every\s+day|daily)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b",
        lower,
    )
    if m:
        time_str = _normalize_clock(m.group(1), m.group(2), m.group(3))
        instruction = re.sub(
            r"\b(?:every\s+day|daily)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b",
            "",
            raw,
            flags=re.IGNORECASE,
        )
        return (
            _clean_instruction(instruction),
            ScheduleSpec(kind="daily", timezone=timezone_name, time=time_str),
        )

    # "every weekday at ..."
    m = re.search(
        r"\bevery\s+weekday\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b",
        lower,
    )
    if m:
        time_str = _normalize_clock(m.group(1), m.group(2), m.group(3))
        instruction = re.sub(
            r"\bevery\s+weekday\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b",
            "",
            raw,
            flags=re.IGNORECASE,
        )
        return (
            _clean_instruction(instruction),
            ScheduleSpec(
                kind="weekly",
                timezone=timezone_name,
                time=time_str,
                weekdays=(0, 1, 2, 3, 4),
            ),
        )

    # "every Monday at 9am"
    m = re.search(
        r"\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
        r"mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)"
        r"\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b",
        lower,
    )
    if m:
        day = WEEKDAY_NAMES[m.group(1)]
        time_str = _normalize_clock(m.group(2), m.group(3), m.group(4))
        instruction = re.sub(
            r"\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
            r"mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)"
            r"\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b",
            "",
            raw,
            flags=re.IGNORECASE,
        )
        return (
            _clean_instruction(instruction),
            ScheduleSpec(
                kind="weekly",
                timezone=timezone_name,
                time=time_str,
                weekdays=(day,),
            ),
        )

    # "tomorrow at 8pm" / "today at 7:30pm" / "at 8pm"
    m = re.search(
        r"\b(?:(tomorrow|today)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b",
        lower,
    )
    if m and (m.group(1) or re.search(r"\bat\s+\d", lower)):
        day_word = m.group(1)
        time_str = _normalize_clock(m.group(2), m.group(3), m.group(4))
        hour, minute = (int(x) for x in time_str.split(":"))
        local = now.astimezone(ZoneInfo(timezone_name))
        target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if day_word == "tomorrow":
            target = target + timedelta(days=1)
        elif target <= local:
            # "today at past time" and bare "at 8pm" after 8pm → next day
            target = target + timedelta(days=1)
        run_at = target.astimezone(timezone.utc).isoformat()
        instruction = re.sub(
            r"\b(?:(tomorrow|today)\s+)?(?:at\s+)?\d{1,2}(?::\d{2})?\s*(am|pm)\b",
            "",
            raw,
            flags=re.IGNORECASE,
        )
        return (
            _clean_instruction(instruction),
            ScheduleSpec(kind="once", timezone=timezone_name, run_at=run_at),
        )

    return None


def _normalize_clock(hour_s: str, minute_s: str | None, ampm: str | None) -> str:
    hour = int(hour_s)
    minute = int(minute_s or "0")
    if ampm:
        ampm = ampm.lower()
        if ampm == "pm" and hour != 12:
            hour += 12
        if ampm == "am" and hour == 12:
            hour = 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ScheduleError("invalid clock time")
    return f"{hour:02d}:{minute:02d}"


def _clean_instruction(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip(" \t\n\r,.-")
    # Drop leading filler like "remind me to"
    cleaned = re.sub(
        r"^(please\s+)?(remind me to|remind me|tell me to)\s+",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned.strip() or text.strip()


def default_title(instruction: str) -> str:
    text = re.sub(r"\s+", " ", instruction).strip()
    if len(text) <= 48:
        return text or "Scheduled task"
    return text[:45].rstrip() + "…"


class ScheduledTaskStore:
    """SQLite-backed store. One DB file; rows are scoped by user_id.

    Persistence: the path must live on durable disk (Docker: the scout-data
    volume mounted at ``~/.config/scout``). The poller reloads from this file
    on every process start — schedules survive restarts. Slots more than
    ``MISS_GRACE_SECONDS`` late are skipped (no catch-up); recurring tasks
    advance to the next boundary with ``last_error`` set so the UI can show a
    red dotted ring until the next successful fire.
    """

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
              task_id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              title TEXT NOT NULL,
              instruction TEXT NOT NULL,
              schedule_json TEXT NOT NULL,
              timezone TEXT NOT NULL,
              status TEXT NOT NULL,
              session_id TEXT,
              next_run_at REAL,
              last_run_at REAL,
              last_error TEXT,
              created_at REAL NOT NULL,
              updated_at REAL NOT NULL,
              run_count INTEGER NOT NULL DEFAULT 0,
              running_since REAL,
              max_runs INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_due
              ON scheduled_tasks(status, next_run_at);
            CREATE INDEX IF NOT EXISTS idx_scheduled_user
              ON scheduled_tasks(user_id, status, updated_at);
            """
        )
        # Migrate DBs created before running_since existed.
        cols = {
            row[1]
            for row in self._conn.execute("PRAGMA table_info(scheduled_tasks)").fetchall()
        }
        if "running_since" not in cols:
            self._conn.execute(
                "ALTER TABLE scheduled_tasks ADD COLUMN running_since REAL"
            )
        if "max_runs" not in cols:
            self._conn.execute(
                "ALTER TABLE scheduled_tasks ADD COLUMN max_runs INTEGER"
            )
        self._conn.commit()

    @property
    def path(self) -> Path:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def recover_after_restart(self) -> int:
        """Release in-flight claims left by a previous process.

        A crash mid-run used to leave ``next_run_at`` NULL forever. We now keep
        ``next_run_at`` and only set ``running_since`` while executing. On boot:
        clear every claim, and for any active row still missing ``next_run_at``
        (legacy) make it due immediately so the poller can pick it up.
        """
        now = time.time()
        with self._lock:
            cleared = self._conn.execute(
                """
                UPDATE scheduled_tasks
                SET running_since=NULL, updated_at=?
                WHERE running_since IS NOT NULL
                """,
                (now,),
            ).rowcount
            legacy = self._conn.execute(
                """
                UPDATE scheduled_tasks
                SET next_run_at=?, updated_at=?
                WHERE status='active' AND next_run_at IS NULL
                """,
                (now - 1, now),
            ).rowcount
            self._conn.commit()
        return int(cleared) + int(legacy)

    def count_all_active(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE status='active'"
            ).fetchone()
            return int(row["n"]) if row else 0

    def count_active(self, user_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE user_id=? AND status='active'",
                (str(user_id),),
            ).fetchone()
            return int(row["n"]) if row else 0

    def create(
        self,
        *,
        user_id: str,
        title: str,
        instruction: str,
        schedule: ScheduleSpec,
        session_id: str | None = None,
        status: str = "active",
        max_runs: int | None = None,
    ) -> dict[str, Any]:
        if status not in {"active", "paused"}:
            raise ScheduleError("status must be active or paused")
        if not instruction.strip():
            raise ScheduleError("instruction is required")
        if max_runs is not None and max_runs < 1:
            raise ScheduleError("max_runs must be >= 1 when set")
        title = (title or default_title(instruction)).strip()[:120]
        now = time.time()
        next_run = compute_next_run(schedule, first=True)
        if next_run is None and schedule.kind == "once" and status == "active":
            next_run = _now_utc()
        task_id = str(uuid.uuid4())
        record = {
            "task_id": task_id,
            "user_id": str(user_id),
            "title": title,
            "instruction": instruction.strip(),
            "schedule_json": json.dumps(schedule.to_dict()),
            "timezone": schedule.timezone,
            "status": status,
            "session_id": session_id,
            "next_run_at": next_run.timestamp() if next_run else None,
            "last_run_at": None,
            "last_error": None,
            "created_at": now,
            "updated_at": now,
            "run_count": 0,
            "max_runs": max_runs,
        }
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO scheduled_tasks(
                  task_id,user_id,title,instruction,schedule_json,timezone,status,
                  session_id,next_run_at,last_run_at,last_error,created_at,updated_at,run_count,max_runs
                ) VALUES (
                  :task_id,:user_id,:title,:instruction,:schedule_json,:timezone,:status,
                  :session_id,:next_run_at,:last_run_at,:last_error,:created_at,:updated_at,:run_count,:max_runs
                )
                """,
                record,
            )
            self._conn.commit()
        return self.get(task_id)  # type: ignore[return-value]

    def get(self, task_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            if user_id is None:
                row = self._conn.execute(
                    "SELECT * FROM scheduled_tasks WHERE task_id=?",
                    (task_id,),
                ).fetchone()
            else:
                row = self._conn.execute(
                    "SELECT * FROM scheduled_tasks WHERE task_id=? AND user_id=?",
                    (task_id, str(user_id)),
                ).fetchone()
        return self._public(dict(row)) if row else None

    def list_for_user(self, user_id: str, *, include_terminal: bool = True) -> list[dict[str, Any]]:
        with self._lock:
            if include_terminal:
                rows = self._conn.execute(
                    """
                    SELECT * FROM scheduled_tasks
                    WHERE user_id=?
                    ORDER BY
                      CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                      COALESCE(next_run_at, 9e18) ASC,
                      updated_at DESC
                    """,
                    (str(user_id),),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT * FROM scheduled_tasks
                    WHERE user_id=? AND status IN ('active','paused')
                    ORDER BY COALESCE(next_run_at, 9e18) ASC, updated_at DESC
                    """,
                    (str(user_id),),
                ).fetchall()
        return [self._public(dict(r)) for r in rows]

    def list_due(self, *, now: float | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Active tasks whose next_run has passed and are not claimed by a live run.

        Call :meth:`skip_missed` first so slots outside the grace window are
        advanced/failed instead of executing late.
        """
        now = now if now is not None else time.time()
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM scheduled_tasks
                WHERE status='active'
                  AND next_run_at IS NOT NULL
                  AND next_run_at <= ?
                  AND running_since IS NULL
                ORDER BY next_run_at ASC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        return [self._public(dict(r)) for r in rows]

    def skip_missed(self, *, now: float | None = None, limit: int = 50) -> int:
        """Skip slots later than the grace window without running them.

        - ``once`` → status ``failed``, ``last_error`` set (completed section, red check)
        - recurring → stay ``active``, advance ``next_run_at`` to the next boundary
          after *now*, set ``last_error`` (red dotted ring until a success)

        Does not increment ``run_count``. Returns how many rows were updated.
        """
        now = now if now is not None else time.time()
        cutoff = now - MISS_GRACE_SECONDS
        skipped = 0
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM scheduled_tasks
                WHERE status='active'
                  AND next_run_at IS NOT NULL
                  AND next_run_at < ?
                  AND running_since IS NULL
                ORDER BY next_run_at ASC
                LIMIT ?
                """,
                (cutoff, limit),
            ).fetchall()
            for row in rows:
                data = dict(row)
                try:
                    spec = ScheduleSpec.from_dict(json.loads(data["schedule_json"]))
                except Exception:
                    spec = None
                if spec is None or spec.kind == "once":
                    self._conn.execute(
                        """
                        UPDATE scheduled_tasks SET
                          status='failed', last_error=?, next_run_at=NULL,
                          running_since=NULL, updated_at=?
                        WHERE task_id=?
                        """,
                        (MISS_ERROR, now, data["task_id"]),
                    )
                else:
                    nxt = compute_next_run(
                        spec,
                        after=datetime.fromtimestamp(now, tz=timezone.utc),
                        first=False,
                    )
                    next_run_at = nxt.timestamp() if nxt else None
                    self._conn.execute(
                        """
                        UPDATE scheduled_tasks SET
                          last_error=?, next_run_at=?, running_since=NULL, updated_at=?
                        WHERE task_id=?
                        """,
                        (MISS_ERROR, next_run_at, now, data["task_id"]),
                    )
                skipped += 1
            if skipped:
                self._conn.commit()
        return skipped

    def update(
        self,
        task_id: str,
        user_id: str,
        *,
        title: str | None = None,
        instruction: str | None = None,
        schedule: ScheduleSpec | None = None,
        status: str | None = None,
        session_id: str | None = None,
        clear_error: bool = False,
    ) -> dict[str, Any] | None:
        existing = self.get(task_id, user_id)
        if not existing:
            return None
        now = time.time()
        new_title = title.strip()[:120] if title is not None else existing["title"]
        new_instruction = (
            instruction.strip() if instruction is not None else existing["instruction"]
        )
        if not new_instruction:
            raise ScheduleError("instruction is required")
        new_status = status if status is not None else existing["status"]
        if new_status not in {"active", "paused", "completed", "failed"}:
            raise ScheduleError("invalid status")
        if schedule is not None:
            schedule_json = json.dumps(schedule.to_dict())
            timezone_name = schedule.timezone
            next_run = compute_next_run(schedule, first=True)
            next_run_at = next_run.timestamp() if next_run else None
        else:
            schedule_json = json.dumps(existing["schedule"])
            timezone_name = existing["timezone"]
            next_run_at = (
                _parse_iso(existing["next_run_at"]).timestamp()
                if existing.get("next_run_at")
                else None
            )
            if status == "active" and existing["status"] != "active":
                # Resuming: recompute next fire from now.
                spec = ScheduleSpec.from_dict(existing["schedule"])
                nxt = compute_next_run(spec, first=True)
                next_run_at = nxt.timestamp() if nxt else None

        new_session = session_id if session_id is not None else existing.get("session_id")
        with self._lock:
            self._conn.execute(
                """
                UPDATE scheduled_tasks SET
                  title=?, instruction=?, schedule_json=?, timezone=?, status=?,
                  session_id=?, next_run_at=?, last_error=CASE WHEN ? THEN NULL ELSE last_error END,
                  updated_at=?
                WHERE task_id=? AND user_id=?
                """,
                (
                    new_title,
                    new_instruction,
                    schedule_json,
                    timezone_name,
                    new_status,
                    new_session,
                    next_run_at,
                    1 if clear_error else 0,
                    now,
                    task_id,
                    str(user_id),
                ),
            )
            self._conn.commit()
        return self.get(task_id, user_id)

    def mark_run_started(self, task_id: str) -> bool:
        """Claim a due task so the poller will not double-fire.

        Keeps ``next_run_at`` so a crash mid-run can recover on restart (claim
        is cleared; the past next_run makes the task due again).
        """
        now = time.time()
        with self._lock:
            cur = self._conn.execute(
                """
                UPDATE scheduled_tasks
                SET running_since=?, updated_at=?
                WHERE task_id=? AND status='active' AND running_since IS NULL
                """,
                (now, now, task_id),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def mark_run_finished(
        self,
        task_id: str,
        *,
        ok: bool,
        error: str | None = None,
        schedule: ScheduleSpec | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM scheduled_tasks WHERE task_id=?",
                (task_id,),
            ).fetchone()
            if not row:
                return None
            data = dict(row)
            now = time.time()
            run_count = int(data["run_count"] or 0) + 1
            try:
                spec = schedule or ScheduleSpec.from_dict(json.loads(data["schedule_json"]))
            except Exception:
                spec = None

            if not ok:
                status = data["status"]
                next_run_at = None
                if spec is not None and data["status"] == "active":
                    # Retry after one hour on failure for recurring; complete once tasks stay failed.
                    if spec.kind == "once":
                        status = "failed"
                    else:
                        next_run_at = now + MIN_INTERVAL_MINUTES * 60
                else:
                    status = "failed"
                self._conn.execute(
                    """
                    UPDATE scheduled_tasks SET
                      status=?, last_run_at=?, last_error=?, next_run_at=?,
                      run_count=?, running_since=NULL, updated_at=?
                    WHERE task_id=?
                    """,
                    (status, now, (error or "run failed")[:2000], next_run_at, run_count, now, task_id),
                )
            else:
                max_runs = data.get("max_runs")
                try:
                    max_runs_i = int(max_runs) if max_runs is not None else None
                except (TypeError, ValueError):
                    max_runs_i = None
                hit_cap = max_runs_i is not None and run_count >= max_runs_i
                if spec is None or spec.kind == "once" or hit_cap:
                    status = "completed"
                    next_run_at = None
                else:
                    status = data["status"] if data["status"] == "active" else data["status"]
                    if status == "active":
                        nxt = compute_next_run(
                            spec,
                            after=datetime.fromtimestamp(now, tz=timezone.utc),
                            first=False,
                        )
                        next_run_at = nxt.timestamp() if nxt else None
                    else:
                        next_run_at = None
                self._conn.execute(
                    """
                    UPDATE scheduled_tasks SET
                      status=?, last_run_at=?, last_error=NULL, next_run_at=?,
                      run_count=?, running_since=NULL, updated_at=?
                    WHERE task_id=?
                    """,
                    (status, now, next_run_at, run_count, now, task_id),
                )
            self._conn.commit()
        return self.get(task_id)

    def set_session_id(self, task_id: str, session_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE scheduled_tasks SET session_id=?, updated_at=? WHERE task_id=?",
                (session_id, time.time(), task_id),
            )
            self._conn.commit()

    def delete(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        """Delete the task. Returns the removed public record (or None)."""
        existing = self.get(task_id, user_id)
        if not existing:
            return None
        with self._lock:
            self._conn.execute(
                "DELETE FROM scheduled_tasks WHERE task_id=? AND user_id=?",
                (task_id, str(user_id)),
            )
            self._conn.commit()
        return existing

    def mark_due_now(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        """Force the task active and due immediately (manual run / tests)."""
        return self.reschedule_at(task_id, time.time() - 1, user_id=user_id, force_active=True)

    def reschedule_at(
        self,
        task_id: str,
        when: float,
        *,
        user_id: str | None = None,
        force_active: bool = False,
    ) -> dict[str, Any] | None:
        """Set next_run_at without counting a finished run (busy/retry paths).

        Always clears ``running_since`` so the poller can claim the task again.
        """
        with self._lock:
            if user_id is None:
                cur = self._conn.execute(
                    """
                    UPDATE scheduled_tasks
                    SET next_run_at=?, running_since=NULL, updated_at=?,
                        status=CASE WHEN ? THEN 'active' ELSE status END
                    WHERE task_id=?
                    """,
                    (when, time.time(), 1 if force_active else 0, task_id),
                )
            else:
                cur = self._conn.execute(
                    """
                    UPDATE scheduled_tasks
                    SET next_run_at=?, running_since=NULL, updated_at=?,
                        status=CASE WHEN ? THEN 'active' ELSE status END
                    WHERE task_id=? AND user_id=?
                    """,
                    (when, time.time(), 1 if force_active else 0, task_id, str(user_id)),
                )
            self._conn.commit()
            if cur.rowcount == 0:
                return None
        return self.get(task_id, user_id)

    def pause_by_session(self, user_id: str, session_id: str) -> list[dict[str, Any]]:
        """Pause active tasks whose conversation was deleted."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT task_id FROM scheduled_tasks
                WHERE user_id=? AND session_id=? AND status='active'
                """,
                (str(user_id), session_id),
            ).fetchall()
        paused: list[dict[str, Any]] = []
        for row in rows:
            updated = self.update(row["task_id"], user_id, status="paused")
            if updated:
                paused.append(updated)
        return paused

    def _public(self, row: dict[str, Any]) -> dict[str, Any]:
        try:
            schedule = json.loads(row["schedule_json"])
        except Exception:
            schedule = {"kind": "once", "timezone": row.get("timezone") or "UTC"}
        try:
            spec = ScheduleSpec.from_dict(schedule)
            label = schedule_label(spec)
        except Exception:
            label = schedule.get("kind", "scheduled")

        def iso(ts: float | None) -> str | None:
            if ts is None:
                return None
            return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()

        return {
            "task_id": row["task_id"],
            "user_id": row["user_id"],
            "title": row["title"],
            "instruction": row["instruction"],
            "schedule": schedule,
            "schedule_label": label,
            "timezone": row["timezone"],
            "status": row["status"],
            "session_id": row["session_id"],
            "next_run_at": iso(row["next_run_at"]),
            "last_run_at": iso(row["last_run_at"]),
            "last_error": row["last_error"],
            "created_at": iso(row["created_at"]),
            "updated_at": iso(row["updated_at"]),
            "run_count": int(row["run_count"] or 0),
            "max_runs": (
                int(row["max_runs"])
                if row.get("max_runs") is not None
                else None
            ),
        }


_global_store: ScheduledTaskStore | None = None


def set_global_store(store: ScheduledTaskStore | None) -> None:
    global _global_store
    _global_store = store


def get_global_store() -> ScheduledTaskStore | None:
    return _global_store


def _project_hash(cwd: str | Path) -> str:
    import hashlib

    return hashlib.sha256(str(Path(cwd).resolve()).encode()).hexdigest()[:12]


def create_task_session(
    *,
    user_id: str,
    title: str,
    cwd: str | Path,
) -> str:
    """Create a dedicated chat JSONL for one scheduled task."""
    from datetime import datetime, timezone

    sessions_root = Path.home() / ".config" / "scout" / "sessions"
    sdir = sessions_root / str(user_id) / _project_hash(cwd)
    sdir.mkdir(parents=True, exist_ok=True)
    session_id = str(uuid.uuid4())
    header = {
        "type": "header",
        "sessionId": session_id,
        "projectDir": str(Path(cwd).resolve()),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "title": (title or "Scheduled task")[:80],
        "model": None,
    }
    path = sdir / f"{session_id}.jsonl"
    path.write_text(json.dumps(header) + "\n", encoding="utf-8")
    return session_id


def session_has_conversation(
    *,
    user_id: str,
    session_id: str,
    cwd: str | Path,
) -> bool:
    """True if the chat has any user/assistant messages (not just a header)."""
    sessions_root = Path.home() / ".config" / "scout" / "sessions"
    path = sessions_root / str(user_id) / _project_hash(cwd) / f"{session_id}.jsonl"
    if not path.exists():
        return False
    try:
        with path.open(encoding="utf-8") as handle:
            for i, line in enumerate(handle):
                if i == 0:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if entry.get("type") in {"user", "assistant"} and (
                    entry.get("content") or entry.get("steps")
                ):
                    return True
    except Exception:
        return False
    return False


def delete_task_session_if_empty(
    *,
    user_id: str,
    session_id: str,
    cwd: str | Path,
) -> bool:
    """Remove a task chat that never got real conversation. Returns True if deleted."""
    if session_has_conversation(user_id=user_id, session_id=session_id, cwd=cwd):
        return False
    sessions_root = Path.home() / ".config" / "scout" / "sessions"
    sdir = sessions_root / str(user_id) / _project_hash(cwd)
    path = sdir / f"{session_id}.jsonl"
    removed = False
    if path.exists():
        path.unlink()
        removed = True
    # Drop companion task sqlite if present
    tasks_db = sdir / f"{session_id}.tasks.sqlite"
    if tasks_db.exists():
        try:
            tasks_db.unlink()
        except Exception:
            pass
    return removed


def rename_task_session(
    *,
    user_id: str,
    session_id: str,
    title: str,
    cwd: str | Path,
) -> None:
    """Update the header title of a task's chat (best-effort)."""
    sessions_root = Path.home() / ".config" / "scout" / "sessions"
    path = sessions_root / str(user_id) / _project_hash(cwd) / f"{session_id}.jsonl"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    if not lines or not lines[0].strip():
        return
    try:
        header = json.loads(lines[0])
    except Exception:
        return
    header["title"] = (title or header.get("title") or "Scheduled task")[:80]
    lines[0] = json.dumps(header)
    path.write_text("\n".join(lines), encoding="utf-8")


def resolve_task_session_id(
    store: ScheduledTaskStore,
    *,
    user_id: str,
    current_session_id: str | None,
    title: str,
    cwd: str | Path,
) -> tuple[str, bool]:
    """Pick which chat owns a new task.

    - Reuse the current chat when it has no *active* scheduled task
      (follow-ups can rename that thread — ChatGPT-style).
    - Otherwise open a fresh chat so a second concurrent task does not share
      a thread.
    """
    uid = str(user_id)
    if current_session_id:
        active_here = [
            t
            for t in store.list_for_user(uid, include_terminal=False)
            if t.get("session_id") == current_session_id and t.get("status") == "active"
        ]
        if not active_here:
            rename_task_session(
                user_id=uid,
                session_id=current_session_id,
                title=title,
                cwd=cwd,
            )
            return current_session_id, False
    new_id = create_task_session(user_id=uid, title=title, cwd=cwd)
    return new_id, True
