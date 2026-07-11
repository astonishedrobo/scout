from scout.config import AppConfig
from scout.retriever import BM25Retriever, _tokenize


def test_tokenize_preserves_and_splits_code_identifiers() -> None:
    tokens = _tokenize("maxLiveSessions request_queue HTTPServer2")

    assert "maxlivesessions" in tokens
    assert {"max", "live", "sessions"}.issubset(tokens)
    assert {"request", "queue"}.issubset(tokens)
    assert {"http", "server", "2"}.issubset(tokens)


def test_search_uses_source_path_as_a_ranking_signal(tmp_path) -> None:
    (tmp_path / "priority_queue_notes.md").write_text(
        "The scheduler admits ordinary work fairly."
    )
    (tmp_path / "unrelated.md").write_text(
        "The scheduler admits ordinary work fairly."
    )

    retriever = BM25Retriever(AppConfig(), workspace_roots=[tmp_path])
    hits = retriever.search("priority queue", top_k=2)

    assert hits
    assert hits[0].source_file == "priority_queue_notes.md"


def test_search_matches_camel_case_identifier_with_natural_words(tmp_path) -> None:
    (tmp_path / "config.md").write_text(
        "The maxLiveSessions setting controls aggregate capacity."
    )
    (tmp_path / "other.md").write_text("Aggregate capacity is configurable.")

    retriever = BM25Retriever(AppConfig(), workspace_roots=[tmp_path])
    hits = retriever.search("live sessions", top_k=2)

    assert hits
    assert hits[0].source_file == "config.md"
