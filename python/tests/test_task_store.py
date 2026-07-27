from pathlib import Path

from scout.task_store import TaskStore


def test_task_store_persists_latest_lifecycle_record(tmp_path: Path):
    store = TaskStore(tmp_path / "tasks.sqlite")
    running, first_sequence = store.upsert({
        "task_id": "terminal-7", "task_type": "terminal", "title": "Long command",
        "status": "running", "created_at": 10.0, "started_at": 10.0,
        "finished_at": None, "summary": "Running command",
    })
    completed, second_sequence = store.upsert({
        "task_id": "terminal-7", "task_type": "terminal", "title": "Long command",
        "status": "completed", "created_at": None, "started_at": None,
        "finished_at": 12.0, "summary": "Command finished", "result_preview": "ok",
    })

    assert first_sequence < second_sequence
    assert running["status"] == "running"
    assert completed["status"] == "completed"
    assert store.list() == [{
        "task_id": "terminal-7", "task_type": "terminal", "title": "Long command",
        "status": "completed", "created_at": 10.0, "started_at": 10.0,
        "finished_at": 12.0, "summary": "Command finished", "result_preview": "ok", "error": None,
    }]


def test_task_store_marks_unmonitored_running_tasks_interrupted(tmp_path: Path):
    store = TaskStore(tmp_path / "tasks.sqlite")
    store.upsert({
        "task_id": "terminal-9", "task_type": "terminal", "title": "Sleep",
        "status": "running", "created_at": 10.0, "started_at": 10.0,
        "finished_at": None, "summary": "Running command",
    })

    recovered = store.interrupt_orphaned_running()

    assert len(recovered) == 1
    assert recovered[0]["status"] == "interrupted"
    assert recovered[0]["summary"] == "Interrupted because Scout restarted"
    assert store.list()[0]["status"] == "interrupted"
