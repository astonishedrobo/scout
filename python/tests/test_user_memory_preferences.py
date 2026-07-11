import importlib
import sys
from pathlib import Path

import pytest
from concurrent.futures import ThreadPoolExecutor


@pytest.fixture(autouse=True)
def _clean_auth_module():
    yield
    sys.modules.pop("scout.server.auth", None)


def _use_temp_auth_db(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    sys.modules.pop("scout.server.auth", None)
    auth = importlib.import_module("scout.server.auth")
    monkeypatch.setattr(auth, "_ADMIN_USERS_ENV", set())
    return auth


def test_user_memory_preferences_are_isolated(tmp_path: Path, monkeypatch):
    auth = _use_temp_auth_db(tmp_path, monkeypatch)
    alice = auth.create_user("alice", "password")
    bob = auth.create_user("bob", "password")
    assert alice and bob

    assert auth.get_user_memory_preferences(alice["id"]) is None
    assert auth.get_user_memory_preferences(bob["id"]) is None

    auth.set_user_memory_preferences(
        alice["id"],
        use_memories=False,
        generate_memories=True,
    )
    auth.set_user_memory_preferences(
        bob["id"],
        use_memories=True,
        generate_memories=False,
    )

    assert auth.get_user_memory_preferences(alice["id"]) == {
        "use_memories": False,
        "generate_memories": True,
    }
    assert auth.get_user_memory_preferences(bob["id"]) == {
        "use_memories": True,
        "generate_memories": False,
    }


def test_user_memory_preferences_upsert(tmp_path: Path, monkeypatch):
    auth = _use_temp_auth_db(tmp_path, monkeypatch)
    user = auth.create_user("user", "password")
    assert user

    auth.set_user_memory_preferences(
        user["id"],
        use_memories=False,
        generate_memories=False,
    )
    auth.set_user_memory_preferences(
        user["id"],
        use_memories=True,
        generate_memories=True,
    )

    assert auth.get_user_memory_preferences(user["id"]) == {
        "use_memories": True,
        "generate_memories": True,
    }


def test_admin_can_assign_admission_group(tmp_path: Path, monkeypatch):
    auth = _use_temp_auth_db(tmp_path, monkeypatch)
    user = auth.create_user("queued-user", "password")
    assert user
    assert auth.get_user_admission_group(user["id"]) == "standard"
    assert auth.set_user_admission_group(user["id"], "priority") is True
    assert auth.get_user_admission_group(user["id"]) == "priority"
    assert auth.list_users()[0]["admission_group"] == "priority"


def test_auth_database_supports_concurrent_preference_writes(tmp_path: Path, monkeypatch):
    auth = _use_temp_auth_db(tmp_path, monkeypatch)
    user = auth.create_user("concurrent", "password")
    assert user

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [
            pool.submit(
                auth.set_user_memory_preferences,
                user["id"],
                use_memories=bool(index % 2),
                generate_memories=bool((index + 1) % 2),
            )
            for index in range(40)
        ]
        for future in futures:
            future.result()

    preferences = auth.get_user_memory_preferences(user["id"])
    assert preferences in (
        {"use_memories": False, "generate_memories": True},
        {"use_memories": True, "generate_memories": False},
    )
    conn = auth._connect()
    assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    conn.close()
