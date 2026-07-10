def test_annotation_metadata_round_trips_through_session_messages(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import scout.server.app as app_module

    monkeypatch.setattr(app_module, "SESSIONS_ROOT", tmp_path / "sessions")
    client = TestClient(app_module.create_app(cwd=tmp_path / "workspace"))
    created = client.post("/sessions")
    assert created.status_code == 200
    session_id = created.json()["sessionId"]

    annotation = {
        "id": "annotation-1",
        "sourceId": "assistant-1-message",
        "quote": "Keep the response focused.",
        "contextBefore": "Before ",
        "contextAfter": " After",
        "comment": "Can you make this actionable?",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
    }
    saved = client.post(
        f"/sessions/{session_id}/messages",
        json={
            "role": "user",
            "content": "Please address annotation 1.",
            "annotations": [annotation],
        },
    )
    assert saved.status_code == 200

    loaded = client.get(f"/sessions/{session_id}")
    assert loaded.status_code == 200
    message = loaded.json()["messages"][0]
    assert message["annotations"] == [annotation]
