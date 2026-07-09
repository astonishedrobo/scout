from scout.path_display import display_path, redact_paths, sanitize_artifacts


def test_display_path_maps_personal_and_shared_roots(tmp_path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"

    assert display_path(personal / "plot.png", personal, shared) == "/workspace/plot.png"
    assert display_path(shared / "report.csv", personal, shared) == "/shared/report.csv"


def test_display_path_preserves_unknown_absolute_paths(tmp_path):
    personal = tmp_path / "users" / "1"
    assert display_path("/etc/passwd", personal) == "/etc/passwd"


def test_display_path_preserves_canonical_sandbox_paths(tmp_path):
    personal = tmp_path / "users" / "1"
    assert display_path("/workspace/report.md", personal) == "/workspace/report.md"
    assert display_path("/shared/data.csv", personal) == "/shared/data.csv"


def test_redact_paths_rewrites_model_visible_text(tmp_path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    text = f"Wrote {personal}/plot.png using {shared}/data.csv; failed at /etc/passwd"

    assert redact_paths(text, personal, shared) == (
        "Wrote /workspace/plot.png using /shared/data.csv; failed at /etc/passwd"
    )


def test_redact_paths_preserves_urls(tmp_path):
    personal = tmp_path / "users" / "1"
    url = "See https://example.com/docs/path for details"
    assert redact_paths(url, personal) == url


def test_redact_paths_rewrites_relative_user_directory(tmp_path):
    personal = tmp_path / "users" / "1"
    assert redact_paths("saved at users/1/plot.png", personal) == "saved at users/1/plot.png"


def test_sanitize_artifacts_preserves_workspace_artifact_path(tmp_path):
    personal = tmp_path / "users" / "1"
    artifacts = [{"id": "x", "path": "plot.png", "name": "plot.png"}]
    assert sanitize_artifacts(artifacts, personal)[0]["path"] == "plot.png"
