from scout.server.app import APPROVAL_MODES, approval_required
from scout.session_snapshot import copy_session_snapshot, load_session_snapshot, save_session_snapshot


def test_approval_mode_matrix_matches_the_user_facing_contract():
    assert APPROVAL_MODES == {"ask_always", "allow_edits", "full_access"}

    for kind in ("file_changes", "execution_promotion", "capability", "permission_elevation"):
        assert approval_required("ask_always", kind)

    assert not approval_required("allow_edits", "file_changes")
    assert not approval_required("allow_edits", "execution_promotion")
    assert approval_required("allow_edits", "capability")
    assert approval_required("allow_edits", "permission_elevation")

    for kind in ("file_changes", "execution_promotion", "capability", "permission_elevation"):
        assert not approval_required("full_access", kind)


def test_unknown_approval_mode_falls_back_to_the_safe_default():
    assert approval_required("not-a-mode", "file_changes")
    assert approval_required("", "capability")


def test_approval_mode_persists_and_forked_session_inherits_it(tmp_path):
    save_session_snapshot(
        tmp_path,
        "parent",
        grants=[{"capability": "network_domain", "scope": {"domains": ["pypi.org"]}}],
        exec_rules=["npm install"],
        active_profile="contributor",
        approval_mode="allow_edits",
    )

    copy_session_snapshot(tmp_path, "parent", "child")

    parent = load_session_snapshot(tmp_path, "parent")
    child = load_session_snapshot(tmp_path, "child")
    assert parent and child
    assert parent["approval_mode"] == "allow_edits"
    assert child["approval_mode"] == "allow_edits"
    assert child["parent_session_id"] == "parent"


def test_session_approval_mode_api_persists_without_initializing_an_agent(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import scout.server.app as app_module

    monkeypatch.setattr(app_module, "SESSIONS_ROOT", tmp_path / "sessions")
    app = app_module.create_app(cwd=tmp_path / "workspace")
    client = TestClient(app)

    created = client.post("/sessions")
    assert created.status_code == 200
    session_id = created.json()["sessionId"]

    assert client.get(f"/sessions/{session_id}/approval-mode").json() == {"mode": "ask_always"}
    changed = client.put(
        f"/sessions/{session_id}/approval-mode",
        json={"mode": "allow_edits"},
    )
    assert changed.status_code == 200
    assert changed.json() == {"mode": "allow_edits"}
    assert client.get(f"/sessions/{session_id}/approval-mode").json() == {"mode": "allow_edits"}

    invalid = client.put(f"/sessions/{session_id}/approval-mode", json={"mode": "unsafe"})
    assert invalid.status_code == 400


def test_session_creation_persists_initial_approval_mode_atomically(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import scout.server.app as app_module

    monkeypatch.setattr(app_module, "SESSIONS_ROOT", tmp_path / "sessions")
    app = app_module.create_app(cwd=tmp_path / "workspace")
    client = TestClient(app)

    created = client.post(
        "/sessions",
        json={"model": "test-model", "approval_mode": "allow_edits"},
    )
    assert created.status_code == 200
    body = created.json()
    assert body["approvalMode"] == "allow_edits"
    assert client.get(f"/sessions/{body['sessionId']}/approval-mode").json() == {
        "mode": "allow_edits",
    }

    listed = client.get("/sessions").json()["sessions"]
    assert next(item for item in listed if item["sessionId"] == body["sessionId"])["model"] == "test-model"


def test_session_creation_rejects_invalid_mode_and_keeps_legacy_query_model(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import scout.server.app as app_module

    monkeypatch.setattr(app_module, "SESSIONS_ROOT", tmp_path / "sessions")
    app = app_module.create_app(cwd=tmp_path / "workspace")
    client = TestClient(app)

    invalid = client.post("/sessions", json={"approval_mode": "unsafe"})
    assert invalid.status_code == 400

    legacy = client.post("/sessions?model=legacy-model")
    assert legacy.status_code == 200
    session_id = legacy.json()["sessionId"]
    listed = client.get("/sessions").json()["sessions"]
    assert next(item for item in listed if item["sessionId"] == session_id)["model"] == "legacy-model"
    assert client.get(f"/sessions/{session_id}/approval-mode").json() == {
        "mode": "ask_always",
    }
