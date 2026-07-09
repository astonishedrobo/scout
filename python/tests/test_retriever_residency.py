from pathlib import Path
import time

from scout.config import AppConfig
from scout.retriever import BM25Retriever, RetrieverProxy, evict_retriever_proxies


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
