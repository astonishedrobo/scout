from pathlib import Path
import time

from scout.config import AppConfig
from scout.retriever import (
    BM25Retriever,
    RetrieverProxy,
    evict_retriever_proxies,
    source_file_matches,
)


def test_proxy_evicts_and_reloads_index_on_demand(tmp_path: Path):
    (tmp_path / "notes.md").write_text("oranges lemons citrus")
    proxy = RetrieverProxy([tmp_path], AppConfig())

    assert proxy.is_resident is False
    assert proxy.search("citrus")
    assert proxy.is_resident is True
    assert proxy.chunk_count > 0
    assert proxy.estimated_resident_bytes > 0

    released = proxy.evict()
    assert released > 0
    assert proxy.is_resident is False

    assert proxy.search("oranges")
    assert proxy.is_resident is True


def test_config_free_json_is_searchable(tmp_path: Path):
    (tmp_path / "records.json").write_text(
        '[{"city": "Pune", "signal": "monsoon"}, {"city": "Delhi", "signal": "heat"}]'
    )

    retriever = BM25Retriever(AppConfig(), workspace_roots=[tmp_path])
    results = retriever.search("monsoon")

    assert results
    assert results[0].source_file == "records.json"
    assert results[0].record_index == 0


def test_registry_eviction_preserves_recent_indexes_and_hard_cap(tmp_path: Path):
    (tmp_path / "notes.md").write_text("bounded retrieval memory")
    proxies = {}
    for user_id in ("oldest", "middle", "newest"):
        proxy = RetrieverProxy([tmp_path], AppConfig())
        assert proxy.search("retrieval")
        proxies[user_id] = proxy
        time.sleep(0.002)

    report = evict_retriever_proxies(
        proxies,
        idle_ttl_seconds=10_000,
        max_resident=2,
    )

    assert report["users"] == ["oldest"]
    assert report["resident_users"] == 2
    assert proxies["oldest"].is_resident is False
    assert proxies["middle"].is_resident is True
    assert proxies["newest"].is_resident is True


def test_source_file_matches_paths_and_basenames():
    assert source_file_matches("docs/report.pdf", "docs/report.pdf")
    assert source_file_matches("docs/report.pdf", "report.pdf")
    assert source_file_matches(
        "docs/report.pdf", "/workspace/users/1/docs/report.pdf"
    )
    assert source_file_matches("docs/report.pdf", r"docs\report.pdf")
    assert not source_file_matches("docs/report.pdf", "other.pdf")
    assert not source_file_matches("docs/report.pdf", "docs/other.pdf")


def test_search_filters_by_source_file_before_topk(tmp_path: Path):
    """Filtering must not be crowded out by higher-scoring chunks elsewhere."""
    (tmp_path / "alpha.md").write_text(
        "climate climate climate climate climate vulnerability index"
    )
    (tmp_path / "beta.md").write_text("climate risk assessment for district")

    retriever = BM25Retriever(AppConfig(), workspace_roots=[tmp_path])

    all_hits = retriever.search("climate", top_k=5)
    assert {c.source_file for c in all_hits} == {"alpha.md", "beta.md"}

    beta_only = retriever.search("climate", top_k=5, source_file="beta.md")
    assert beta_only
    assert all(c.source_file == "beta.md" for c in beta_only)

    # Absolute path and nested-style request still resolve to the same file.
    via_abs = retriever.search(
        "climate", top_k=5, source_file=str(tmp_path / "beta.md")
    )
    assert via_abs
    assert all(c.source_file == "beta.md" for c in via_abs)

    none = retriever.search("climate", top_k=5, source_file="missing.md")
    assert none == []


def test_proxy_search_forwards_source_file_filter(tmp_path: Path):
    (tmp_path / "keep.md").write_text("unique_token_keep only here")
    (tmp_path / "skip.md").write_text("unique_token_keep also elsewhere")
    proxy = RetrieverProxy([tmp_path], AppConfig())

    hits = proxy.search("unique_token_keep", top_k=5, source_file="keep.md")
    assert hits
    assert all(c.source_file == "keep.md" for c in hits)


def test_search_documents_tool_path_limits_to_one_file(tmp_path: Path):
    from scout.agent.tools import make_tools

    (tmp_path / "alpha.md").write_text("shared_keyword only in alpha story")
    (tmp_path / "beta.md").write_text("shared_keyword only in beta story")
    retriever = BM25Retriever(AppConfig(), workspace_roots=[tmp_path])
    tools = {t.name: t for t in make_tools(retriever, str(tmp_path))}
    assert "read_pdf" not in tools
    search = tools["search_documents"]

    all_hits = search.invoke({"query": "shared_keyword", "top_k": 5})
    assert "alpha.md" in all_hits and "beta.md" in all_hits

    scoped = search.invoke(
        {"query": "shared_keyword", "path": "beta.md", "top_k": 5}
    )
    assert "beta.md" in scoped
    assert "alpha.md" not in scoped
