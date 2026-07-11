from pathlib import Path

from scout.agent.tools import make_tools
from scout.config import AppConfig
from scout.fts_retriever import SQLiteFTSRetriever
from scout.retriever import RetrieverProxy


def _config() -> AppConfig:
    return AppConfig(retriever={"backend": "sqlite_fts5", "top_k": 5})


def test_fts_prefix_search_finds_scoped_shared_document_and_skips_csv(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    report = shared / "climate-report.md"
    report.write_text(
        "Assam is the most vulnerable state in the vulnerability index.",
        encoding="utf-8",
    )
    (personal / "large.csv").write_text(
        "state,note\nAssam,most vulnerable state\n", encoding="utf-8"
    )

    retriever = SQLiteFTSRetriever(_config(), [personal, shared])
    hits = retriever.search("vulnerab", source_file=str(report))

    assert hits
    assert {hit.source_file for hit in hits} == {"climate-report.md"}
    assert retriever.search("most vulnerable", source_file="large.csv") == []
    assert (personal / ".scout-cache" / "retrieval-fts5-v1.sqlite3").is_file()


def test_fts_reuses_unchanged_persistent_index(tmp_path: Path):
    personal = tmp_path / "personal"
    shared = tmp_path / "shared"
    personal.mkdir()
    shared.mkdir()
    (shared / "report.md").write_text("climate resilience", encoding="utf-8")

    first = SQLiteFTSRetriever(_config(), [personal, shared])
    database = personal / ".scout-cache" / "retrieval-fts5-v1.sqlite3"
    first_mtime = database.stat().st_mtime_ns
    second = SQLiteFTSRetriever(_config(), [personal, shared])

    assert second.chunk_count == first.chunk_count
    assert database.stat().st_mtime_ns == first_mtime
    assert second.search("resilience")


def test_proxy_uses_deployment_backend_without_agent_parameter(tmp_path: Path):
    (tmp_path / "report.md").write_text("indexed narrative", encoding="utf-8")
    proxy = RetrieverProxy([tmp_path], _config())

    assert proxy.search("narrative")
    assert isinstance(proxy._inner, SQLiteFTSRetriever)


def test_search_and_table_tools_enforce_file_type_boundary(tmp_path: Path):
    (tmp_path / "data.csv").write_text(
        "state,score\nAssam,0.616\nBihar,0.448\n", encoding="utf-8"
    )
    (tmp_path / "report.md").write_text("Assam vulnerability", encoding="utf-8")
    retriever = SQLiteFTSRetriever(_config(), [tmp_path])
    tools = {tool.name: tool for tool in make_tools(retriever, tmp_path)}

    csv_search = tools["search_workspace"].invoke({"query": "Assam", "path": "data.csv"})
    pdf_filter = tools["filter_table"].invoke({"path": "report.md", "query": "Assam"})
    row = tools["filter_table"].invoke({
        "path": "data.csv", "query": "assam", "columns": ["state"]
    })
    bad_column = tools["filter_table"].invoke({
        "path": "data.csv", "query": "assam", "columns": ["missing"]
    })

    assert "Use filter_table" in csv_search
    assert "Use search_workspace" in pdf_filter
    assert "row 2: state: Assam | score: 0.616" in row
    assert "Available columns: state, score" in bad_column
    schema = tools["search_workspace"].args_schema.model_json_schema()
    assert "backend" not in schema["properties"]
