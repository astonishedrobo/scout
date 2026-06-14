from scout.artifacts import html_artifact_warning, local_html_assets


def test_local_html_assets_detects_relative_references():
    html = '<img src="plot.png"><a href="notes.txt">notes</a><img src="data:image/png;base64,abc">'
    assert local_html_assets(html) == ["plot.png", "notes.txt"]


def test_html_artifact_warning_requires_real_embedding(tmp_path):
    path = tmp_path / "report.html"
    path.write_text('<img src="plot.png">')
    warning = html_artifact_warning(path)
    assert "HTML NOT SELF-CONTAINED" in warning
    assert "data: URIs" in warning


def test_html_artifact_warning_accepts_data_uri(tmp_path):
    path = tmp_path / "report.html"
    path.write_text('<img src="data:image/png;base64,abc">')
    assert html_artifact_warning(path) == ""
