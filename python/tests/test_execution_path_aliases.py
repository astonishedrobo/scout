from pathlib import Path

from scout.execution.path_aliases import translate_workspace_paths


def test_translate_workspace_paths_for_worker_mounts():
    personal = Path("/srv/scout-source/users/7")
    shared = Path("/srv/scout-source/shared")

    command = (
        "python3 analyze.py /app/workspace/shared/data/climate.csv "
        "workspace/input.csv /workspace/users/7/report.csv"
    )

    assert translate_workspace_paths(
        command,
        personal_root=personal,
        shared_root=shared,
        user_id="7",
    ) == (
        "python3 analyze.py /srv/scout-source/shared/data/climate.csv "
        "/srv/scout-source/users/7/input.csv "
        "/srv/scout-source/users/7/report.csv"
    )


def test_translate_workspace_paths_does_not_rewrite_unrelated_names():
    command = "printf shared_value ./shared/file.csv /opt/workspace/file.csv"

    assert translate_workspace_paths(
        command,
        personal_root=Path("/users/1"),
        shared_root=Path("/shared"),
        user_id="1",
    ) == command
