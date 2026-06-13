import os


def test_local_launch_is_single_user(monkeypatch):
    monkeypatch.delenv("SCOUT_SERVER_DEPLOYMENT", raising=False)
    assert os.environ.get("SCOUT_SERVER_DEPLOYMENT", "").lower() != "docker"


def test_docker_marker_enables_multi_user(monkeypatch):
    monkeypatch.setenv("SCOUT_SERVER_DEPLOYMENT", "docker")
    assert os.environ.get("SCOUT_SERVER_DEPLOYMENT", "").lower() == "docker"
