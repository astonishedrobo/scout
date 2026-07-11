from scout.agent import ScoutAgent
from scout.config import AppConfig


def test_permission_callback_is_available_during_single_initial_graph_build(
    tmp_path, monkeypatch
):
    builds = []

    def record_build(self, focus_path=None):
        builds.append((focus_path, self._request_permissions_fn))

    class FakeSession:
        def __init__(self, **_kwargs):
            pass

    monkeypatch.setattr(ScoutAgent, "_rebuild_graph", record_build)
    monkeypatch.setattr("scout.agent.PersistentPythonSession", FakeSession)

    async def request_permissions(_reason, _domains):
        return "ok"

    config = AppConfig(
        execution={"enabled": False},
        memories={"use_memories": False, "generate_memories": False},
    )
    ScoutAgent(
        cwd=tmp_path,
        config=config,
        retriever=object(),
        request_permissions_fn=request_permissions,
    )

    assert builds == [(None, request_permissions)]
