"""Autonomous BM25 retriever over text, JSON, and CSV files."""

from __future__ import annotations

import csv
import json
import logging
import re
from pathlib import Path

from langchain_text_splitters import RecursiveCharacterTextSplitter
from rank_bm25 import BM25Okapi

from .config import AppConfig, JSONSourceConfig
from .models import RetrievedChunk

logger = logging.getLogger(__name__)


class BM25Retriever:
    """Index and search local project data using BM25.

    Indexing is autonomous: Scout discovers likely data roots from config
    paths and the project cwd, then indexes ``.txt/.md/.json/.csv`` files.
    Optional ``json_sources`` entries still improve metadata/contexting but
    are no longer required for JSON files to be searchable.
    """

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._chunks: list[_Chunk] = []
        self._bm25: BM25Okapi | None = None

        self._splitter = RecursiveCharacterTextSplitter(
            chunk_size=config.retriever.chunk_size,
            chunk_overlap=config.retriever.chunk_overlap,
            separators=["\n\n", "\n", ". ", " ", ""],
            keep_separator=True,
        )

        self._index_files()

    @property
    def is_empty(self) -> bool:
        return len(self._chunks) == 0

    def search(self, query: str, top_k: int | None = None) -> list[RetrievedChunk]:
        """Return top-k chunks matching *query* via BM25."""
        if self._bm25 is None or self.is_empty:
            return []

        k = top_k if top_k is not None else self._config.retriever.top_k
        tokens = _tokenize(query)
        scores = self._bm25.get_scores(tokens)

        # Get indices of top-k scores
        ranked_idxs = sorted(
            range(len(scores)), key=lambda i: scores[i], reverse=True
        )[:k]

        results: list[RetrievedChunk] = []
        for idx in ranked_idxs:
            if scores[idx] <= 0:
                break
            chunk = self._chunks[idx]
            results.append(
                RetrievedChunk(
                    source_file=chunk.source_file,
                    text=chunk.text,
                    score=float(scores[idx]),
                    source_type=chunk.source_type,
                    record_index=chunk.record_index,
                    metadata=chunk.metadata,
                )
            )

        logger.info("BM25 search for '%s' returned %d chunks", query, len(results))
        return results

    # ── Indexing ────────────────────────────────────────────────────────

    MAX_INDEX_BYTES = 100_000_000  # 100 MB total text limit
    MAX_CHUNKS = 50_000           # Cap total chunks to prevent OOM

    def _index_files(self) -> None:
        """Read, chunk, and index local text/JSON/CSV files."""
        raw_texts: list[_Chunk] = []
        total_bytes = 0
        
        for root in self._candidate_roots():
            for fpath in self._iter_supported_files(root):
                if total_bytes >= self.MAX_INDEX_BYTES or len(raw_texts) >= self.MAX_CHUNKS:
                    logger.warning(
                        "Indexing limit reached (%d MB / %d chunks). Skipping remaining files.",
                        total_bytes // (1024 * 1024), len(raw_texts)
                    )
                    break
                
                new_chunks = self._read_file_safe(fpath, root)
                for c in new_chunks:
                    total_bytes += len(c.text)
                    raw_texts.append(c)
                    if len(raw_texts) >= self.MAX_CHUNKS:
                        break
            
            if total_bytes >= self.MAX_INDEX_BYTES or len(raw_texts) >= self.MAX_CHUNKS:
                break

        if not raw_texts:
            logger.info("No text/JSON/CSV files found to index.")
            return

        corpus: list[list[str]] = []
        filtered_chunks: list[_Chunk] = []
        for chunk in raw_texts:
            tokens = _tokenize(chunk.text)
            if not tokens:
                continue
            filtered_chunks.append(chunk)
            corpus.append(tokens)
        if not corpus:
            logger.info("No tokenizable chunks found for BM25.")
            return

        self._chunks = filtered_chunks
        self._bm25 = BM25Okapi(corpus)
        logger.info("BM25 index built with %d chunks (~%d MB)", len(self._chunks), total_bytes // (1024 * 1024))

    def _read_file_safe(self, fpath: Path, root: Path) -> list[_Chunk]:
        """Wrapper around specific file readers with suffix dispatch."""
        suffix = fpath.suffix.lower()
        try:
            if suffix in {".txt", ".md"}:
                return self._read_text_file(fpath, root)
            elif suffix == ".json":
                return self._read_json_file(fpath, root)
            elif suffix == ".csv":
                return self._read_csv_file(fpath, root)
        except Exception as exc:
            logger.debug("Failed to read %s for indexing: %s", fpath, exc)
        return []

    def _candidate_roots(self) -> list[Path]:
        """Return deduplicated roots to scan for data files."""
        roots: list[Path] = []

        # Config-derived roots (if present)
        for key in self._config.data_paths.keys():
            try:
                p = self._config.get_path(key)
            except KeyError:
                continue
            base = p if p.is_dir() else p.parent
            roots.append(self._normalize_root(base))

        # Fallback to project cwd
        roots.append(self._normalize_root(self._config._config_dir))

        # Deduplicate while preserving order
        seen: set[Path] = set()
        uniq: list[Path] = []
        for r in roots:
            if r in seen or not r.exists():
                continue
            seen.add(r)
            uniq.append(r)
        return uniq

    @staticmethod
    def _normalize_root(path: Path) -> Path:
        known_data_leafs = {
            "meta_files", "csv_files", "text_files", "json_files", "pdf_files",
        }
        if path.name in known_data_leafs:
            return path.parent
        return path

    def _read_root(self, root: Path) -> list[_Chunk]:
        """Index supported files recursively under a root directory."""
        chunks: list[_Chunk] = []
        for fpath in self._iter_supported_files(root):
            suffix = fpath.suffix.lower()
            if suffix in {".txt", ".md"}:
                chunks.extend(self._read_text_file(fpath, root))
            elif suffix == ".json":
                chunks.extend(self._read_json_file(fpath, root))
            elif suffix == ".csv":
                chunks.extend(self._read_csv_file(fpath, root))
        return chunks

    def _iter_supported_files(self, root: Path):
        """Yield supported files while skipping heavy/system folders."""
        supported_exts = {".txt", ".md", ".json", ".csv"}
        skip_dirs = {
            ".git", ".scout", "__pycache__", ".venv", "venv",
            "node_modules", ".mypy_cache", ".pytest_cache",
        }
        stack = [root]
        while stack:
            current = stack.pop()
            try:
                entries = sorted(current.iterdir(), key=lambda p: p.name.lower())
            except Exception:
                continue
            for entry in entries:
                if entry.is_dir():
                    if entry.name in skip_dirs:
                        continue
                    stack.append(entry)
                    continue
                if entry.suffix.lower() in supported_exts:
                    # Avoid huge files that hurt startup/search quality.
                    try:
                        if entry.stat().st_size <= 5_000_000:
                            yield entry
                    except Exception:
                        continue

    def _source_name(self, fpath: Path, root: Path) -> str:
        try:
            return str(fpath.relative_to(root))
        except Exception:
            return str(fpath.name)

    def _read_text_file(self, fpath: Path, root: Path) -> list[_Chunk]:
        """Read one .txt/.md file and split it into chunks."""
        chunks: list[_Chunk] = []
        try:
            text = fpath.read_text(errors="replace")
        except Exception:
            return chunks
        if text.strip():
            chunks.extend(self._split_text(text, self._source_name(fpath, root)))
        return chunks

    def _read_json_file(self, fpath: Path, root: Path) -> list[_Chunk]:
        """Read a JSON file and create chunks (config-aware when available)."""
        chunks: list[_Chunk] = []
        source_file = self._source_name(fpath, root)
        try:
            data = json.loads(fpath.read_text(errors="replace"))
        except json.JSONDecodeError:
            logger.warning("Skipping invalid JSON: %s", fpath)
            return chunks
        except Exception:
            return chunks

        src_config = self._config.json_sources.get(fpath.name)
        if src_config and isinstance(data, list):
            chunks.extend(self._process_json_records(data, source_file, src_config))
            return chunks

        # Config-free JSON indexing: flatten records/objects to text.
        if isinstance(data, list):
            for idx, item in enumerate(data):
                text = self._flatten_json(item)
                if not text.strip():
                    continue
                for split_text in self._splitter.split_text(text):
                    chunks.append(
                        _Chunk(
                            source_file=source_file,
                            text=split_text,
                            source_type="json",
                            record_index=idx,
                        )
                    )
            return chunks

        text = self._flatten_json(data)
        if text.strip():
            for split_text in self._splitter.split_text(text):
                chunks.append(_Chunk(source_file=source_file, text=split_text, source_type="json"))
        return chunks

    def _read_csv_file(self, fpath: Path, root: Path) -> list[_Chunk]:
        """Read a CSV and index rows as textual records."""
        chunks: list[_Chunk] = []
        source_file = self._source_name(fpath, root)
        try:
            with open(fpath, "r", newline="", encoding="utf-8", errors="replace") as fh:
                reader = csv.DictReader(fh)
                for idx, row in enumerate(reader):
                    if not row:
                        continue
                    parts = []
                    for k, v in row.items():
                        if v is None:
                            continue
                        sv = str(v).strip()
                        if not sv:
                            continue
                        parts.append(f"{k}: {sv}")
                    row_text = " | ".join(parts)
                    if not row_text:
                        continue
                    for split_text in self._splitter.split_text(row_text):
                        chunks.append(
                            _Chunk(
                                source_file=source_file,
                                text=split_text,
                                source_type="csv",
                                record_index=idx,
                            )
                        )
        except Exception:
            return chunks
        return chunks

    def _flatten_json(self, value) -> str:
        """Flatten nested JSON recursively into a searchable text blob."""
        parts: list[str] = []

        def _walk(v, prefix: str = "") -> None:
            if v is None:
                return
            if isinstance(v, dict):
                for key, child in v.items():
                    next_prefix = f"{prefix}.{key}" if prefix else str(key)
                    _walk(child, next_prefix)
                return
            if isinstance(v, list):
                for i, child in enumerate(v):
                    next_prefix = f"{prefix}[{i}]" if prefix else f"[{i}]"
                    _walk(child, next_prefix)
                return
            sval = str(v).strip()
            if not sval:
                return
            if prefix:
                parts.append(f"{prefix}: {sval}")
            else:
                parts.append(sval)

        _walk(value)
        return "\n".join(parts)

    def _process_json_records(
        self,
        records: list[dict],
        source_file: str,
        src_config: JSONSourceConfig,
    ) -> list[_Chunk]:
        """Turn a list of JSON records into _Chunk objects."""
        chunks: list[_Chunk] = []
        context_fields = set(src_config.context_fields)
        metadata_fields_cfg = src_config.metadata_fields

        for record_idx, record in enumerate(records):
            if not isinstance(record, dict):
                continue

            # ── Build context text (combined context fields) ─────────
            context_parts: list[str] = []
            for field in src_config.context_fields:
                val = record.get(field)
                if val is not None:
                    context_parts.append(str(val))
            context_text = "\n\n".join(context_parts)

            if not context_text.strip():
                continue

            # ── Build metadata dict ──────────────────────────────────
            if metadata_fields_cfg:
                # Explicit list of metadata fields
                meta = {
                    k: str(record[k])
                    for k in metadata_fields_cfg
                    if k in record and record[k] is not None
                }
            else:
                # All non-context fields become metadata
                meta = {
                    k: str(v)
                    for k, v in record.items()
                    if k not in context_fields and v is not None
                }

            # ── Chunk context text only ──────────────────────────────
            text_splits = self._splitter.split_text(context_text)
            for split_text in text_splits:
                chunks.append(
                    _Chunk(
                        source_file=source_file,
                        text=split_text,
                        source_type="json",
                        record_index=record_idx,
                        metadata=meta,
                    )
                )

        return chunks

    # ── Splitting helpers ────────────────────────────────────────────────

    def _split_text(self, text: str, source_file: str) -> list[_Chunk]:
        """Split text/PDF content using RecursiveCharacterTextSplitter."""
        docs = self._splitter.split_text(text)
        return [_Chunk(source_file, chunk_text) for chunk_text in docs]


# ── Internal helpers ────────────────────────────────────────────────────


class _Chunk:
    """Lightweight container for an indexed text chunk."""

    __slots__ = ("source_file", "text", "source_type", "record_index", "metadata")

    def __init__(
        self,
        source_file: str,
        text: str,
        source_type: str = "text",
        record_index: int | None = None,
        metadata: dict[str, str] | None = None,
    ) -> None:
        self.source_file = source_file
        self.text = text
        self.source_type = source_type
        self.record_index = record_index
        self.metadata = metadata


def _tokenize(text: str) -> list[str]:
    """Lowercase regex tokenizer (punctuation-insensitive)."""
    return re.findall(r"[a-z0-9]+", text.lower())
