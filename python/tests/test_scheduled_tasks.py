"""Unit tests for scheduled task storage and schedule math."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from scout.scheduled_tasks import (
    MIN_INTERVAL_MINUTES,
    MISS_ERROR,
    MISS_GRACE_SECONDS,
    ScheduleError,
    ScheduleSpec,
    ScheduledTaskStore,
    compute_next_run,
    parse_natural_schedule,
    schedule_label,
)


def test_once_next_run_future():
    run_at = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    spec = ScheduleSpec(kind="once", timezone="UTC", run_at=run_at.isoformat())
    after = datetime(2026, 7, 30, 0, 0, tzinfo=timezone.utc)
    assert compute_next_run(spec, after=after) == run_at


def test_once_next_run_past_returns_none():
    run_at = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
    spec = ScheduleSpec(kind="once", timezone="UTC", run_at=run_at.isoformat())
    after = datetime(2026, 7, 30, 0, 0, tzinfo=timezone.utc)
    assert compute_next_run(spec, after=after) is None


def test_interval_min_floor():
    with pytest.raises(ScheduleError):
        ScheduleSpec.from_dict({"kind": "interval", "interval_minutes": 15, "timezone": "UTC"})


def test_daily_next_run_rolls_to_tomorrow():
    spec = ScheduleSpec(kind="daily", timezone="UTC", time="09:00")
    after = datetime(2026, 7, 30, 10, 0, tzinfo=timezone.utc)
    nxt = compute_next_run(spec, after=after)
    assert nxt == datetime(2026, 7, 31, 9, 0, tzinfo=timezone.utc)


def test_weekly_next_run_picks_matching_weekday():
    # 2026-07-30 is Thursday (weekday 3). Next Monday = Aug 3.
    spec = ScheduleSpec(kind="weekly", timezone="UTC", time="08:00", weekdays=(0,))
    after = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
    nxt = compute_next_run(spec, after=after)
    assert nxt == datetime(2026, 8, 3, 8, 0, tzinfo=timezone.utc)
    assert nxt.weekday() == 0


def test_parse_natural_uses_client_timezone_for_wall_clock():
    """'9am' is local to the zone the client sent — not server UTC."""
    now = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)  # 08:30 IST
    parsed = parse_natural_schedule(
        "Remind me today at 9am to stretch",
        timezone_name="Asia/Kolkata",
        now=now,
    )
    assert parsed is not None
    _, schedule = parsed
    assert schedule.timezone == "Asia/Kolkata"
    assert schedule.kind == "once"
    run_at = datetime.fromisoformat(schedule.run_at.replace("Z", "+00:00"))
    # 09:00 IST = 03:30 UTC
    assert run_at.astimezone(timezone.utc).hour == 3
    assert run_at.astimezone(timezone.utc).minute == 30


def test_parse_natural_in_minutes():
    now = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
    parsed = parse_natural_schedule(
        "Remind me in 5 minutes to stretch",
        timezone_name="Asia/Kolkata",
        now=now,
    )
    assert parsed is not None
    instruction, schedule = parsed
    assert "stretch" in instruction.lower()
    assert schedule.kind == "once"
    run_at = datetime.fromisoformat(schedule.run_at.replace("Z", "+00:00"))
    assert abs((run_at - (now + timedelta(minutes=5))).total_seconds()) < 2


def test_parse_natural_every_weekday():
    parsed = parse_natural_schedule(
        "Every weekday at 9am give me one interview question",
        timezone_name="Asia/Kolkata",
    )
    assert parsed is not None
    instruction, schedule = parsed
    assert "interview" in instruction.lower()
    assert schedule.kind == "weekly"
    assert schedule.weekdays == (0, 1, 2, 3, 4)
    assert schedule.time == "09:00"


def test_parse_natural_every_monday():
    parsed = parse_natural_schedule(
        "Every Monday at 8 AM search for LLM papers",
        timezone_name="UTC",
    )
    assert parsed is not None
    _, schedule = parsed
    assert schedule.kind == "weekly"
    assert schedule.weekdays == (0,)
    assert schedule.time == "08:00"


def test_store_create_list_pause_delete(tmp_path: Path):
    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    spec = ScheduleSpec(
        kind="once",
        timezone="UTC",
        run_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    )
    task = store.create(
        user_id="1",
        title="Demo",
        instruction="Say hello",
        schedule=spec,
        session_id="sess-1",
    )
    assert task["status"] == "active"
    assert task["session_id"] == "sess-1"
    assert task["schedule_label"]
    assert store.count_active("1") == 1
    assert len(store.list_for_user("1")) == 1

    paused = store.update(task["task_id"], "1", status="paused")
    assert paused is not None
    assert paused["status"] == "paused"
    assert store.count_active("1") == 0

    removed = store.delete(task["task_id"], "1")
    assert removed is not None
    assert removed["task_id"] == task["task_id"]
    assert store.get(task["task_id"], "1") is None


def test_store_due_and_run_lifecycle(tmp_path: Path):
    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    task = store.create(
        user_id="default",
        title="Due soon",
        instruction="Ping",
        schedule=ScheduleSpec(kind="once", timezone="UTC", run_at=past),
    )
    due = store.list_due()
    assert any(t["task_id"] == task["task_id"] for t in due)

    assert store.mark_run_started(task["task_id"]) is True
    # Claimed: still has next_run_at, but not listed as due (no double-fire).
    assert store.get(task["task_id"])["next_run_at"] is not None
    assert store.list_due() == []
    # Second claim fails while first is in flight.
    assert store.mark_run_started(task["task_id"]) is False

    finished = store.mark_run_finished(task["task_id"], ok=True)
    assert finished["status"] == "completed"
    assert finished["run_count"] == 1


def test_store_survives_reopen_and_recovers_mid_run(tmp_path: Path):
    """Docker restart: same SQLite file, reclaim orphaned runs, fire overdue."""
    path = tmp_path / "tasks.sqlite"
    store = ScheduledTaskStore(path)
    past = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
    task = store.create(
        user_id="u1",
        title="Persisted",
        instruction="Say hi",
        schedule=ScheduleSpec(kind="once", timezone="Asia/Kolkata", run_at=past),
    )
    store.mark_run_started(task["task_id"])  # crash happens before finish
    store.close()

    # New process opens the same DB (compose volume).
    store2 = ScheduledTaskStore(path)
    recovered = store2.recover_after_restart()
    assert recovered >= 1
    loaded = store2.get(task["task_id"], "u1")
    assert loaded is not None
    assert loaded["status"] == "active"
    assert loaded["instruction"] == "Say hi"
    assert loaded["timezone"] == "Asia/Kolkata"
    due = store2.list_due()
    assert any(t["task_id"] == task["task_id"] for t in due)


def test_max_runs_completes_recurring(tmp_path: Path):
    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    task = store.create(
        user_id="default",
        title="Twice",
        instruction="hi",
        schedule=ScheduleSpec(kind="interval", timezone="UTC", interval_minutes=MIN_INTERVAL_MINUTES),
        max_runs=2,
    )
    store.mark_run_started(task["task_id"])
    mid = store.mark_run_finished(
        task["task_id"],
        ok=True,
        schedule=ScheduleSpec(kind="interval", timezone="UTC", interval_minutes=MIN_INTERVAL_MINUTES),
    )
    assert mid["status"] == "active"
    assert mid["run_count"] == 1
    store.mark_run_started(task["task_id"])
    done = store.mark_run_finished(
        task["task_id"],
        ok=True,
        schedule=ScheduleSpec(kind="interval", timezone="UTC", interval_minutes=MIN_INTERVAL_MINUTES),
    )
    assert done["status"] == "completed"
    assert done["run_count"] == 2
    assert done["next_run_at"] is None


def test_interval_run_reschedules(tmp_path: Path):
    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    task = store.create(
        user_id="default",
        title="Hourly",
        instruction="Check status",
        schedule=ScheduleSpec(kind="interval", timezone="UTC", interval_minutes=MIN_INTERVAL_MINUTES),
    )
    assert store.mark_run_started(task["task_id"]) is True
    finished = store.mark_run_finished(
        task["task_id"],
        ok=True,
        schedule=ScheduleSpec(kind="interval", timezone="UTC", interval_minutes=MIN_INTERVAL_MINUTES),
    )
    assert finished["status"] == "active"
    assert finished["next_run_at"] is not None
    assert finished["run_count"] == 1
    # Claim released — not due until the next interval.
    assert store.list_due() == []


def test_schedule_label_readable():
    label = schedule_label(
        ScheduleSpec(kind="weekly", timezone="UTC", time="09:00", weekdays=(0, 2, 4))
    )
    assert "Mon" in label


def test_skip_missed_once_fails_without_run(tmp_path: Path):
    import time as time_mod

    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    # Create with a future once, then push next_run_at past grace (simulates downtime).
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    task = store.create(
        user_id="default",
        title="Too late",
        instruction="Ping",
        schedule=ScheduleSpec(kind="once", timezone="UTC", run_at=future),
    )
    store.reschedule_at(
        task["task_id"],
        time_mod.time() - (MISS_GRACE_SECONDS + 120),
        user_id="default",
    )
    n = store.skip_missed()
    assert n == 1
    row = store.get(task["task_id"])
    assert row["status"] == "failed"
    assert row["last_error"] == MISS_ERROR
    assert row["next_run_at"] is None
    assert row["run_count"] == 0
    assert store.list_due() == []


def test_skip_missed_recurring_advances_and_flags(tmp_path: Path):
    import time as time_mod

    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    # Create a daily task, then shove next_run_at far into the past.
    task = store.create(
        user_id="default",
        title="Morning",
        instruction="Good morning",
        schedule=ScheduleSpec(kind="daily", timezone="UTC", time="07:00"),
    )
    past = time_mod.time() - (MISS_GRACE_SECONDS + 3600)
    store.reschedule_at(task["task_id"], past, user_id="default")
    n = store.skip_missed()
    assert n == 1
    row = store.get(task["task_id"])
    assert row["status"] == "active"
    assert row["last_error"] == MISS_ERROR
    assert row["run_count"] == 0
    assert row["next_run_at"] is not None
    # Next slot is in the future — not listed as due.
    assert store.list_due() == []
    # Success path clears last_error (red dotted ring goes monochrome again).
    store.reschedule_at(task["task_id"], time_mod.time() - 30, user_id="default")
    assert store.mark_run_started(task["task_id"]) is True
    done = store.mark_run_finished(
        task["task_id"],
        ok=True,
        schedule=ScheduleSpec(kind="daily", timezone="UTC", time="07:00"),
    )
    assert done["last_error"] is None
    assert done["status"] == "active"


def test_within_grace_still_due(tmp_path: Path):
    store = ScheduledTaskStore(tmp_path / "tasks.sqlite")
    recent = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
    task = store.create(
        user_id="default",
        title="Recent",
        instruction="Ping",
        schedule=ScheduleSpec(kind="once", timezone="UTC", run_at=recent),
    )
    assert store.skip_missed() == 0
    due = store.list_due()
    assert any(t["task_id"] == task["task_id"] for t in due)
