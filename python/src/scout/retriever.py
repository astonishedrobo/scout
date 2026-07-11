"""Autonomous BM25 retriever over text, JSON, and CSV files."""

from __future__ import annotations

import csv
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Callable, TypedDict

from rank_bm25 import BM25Plus

from .config import AppConfig, JSONSourceConfig
from .models import RetrievedChunk
from .text_splitter import OverlappingTextSplitter

logger = logging.getLogger(__name__)


class EvictionReport(TypedDict):
    users: list[str]
    released_bytes: int
    resident_users: int


class BM25Retriever:
    """Index and search local project data using BM25.

    Indexing is autonomous: Scout discovers likely data roots from config
    paths and the project cwd, then indexes ``.txt/.md/.json/.csv/.pdf`` files.
    Optional ``json_sources`` entries still improve metadata/contexting but
    are no longer required for JSON files to be searchable.

    Parameters
    ----------
    workspace_roots : list[Path] | None
        When provided, scanning is restricted to exactly these directories
        (in order), bypassing the config-derived root discovery. Used in
        multi-user mode to scope each user to their personal + shared dirs.
    """

    def __init__(self, config: AppConfig, workspace_roots: list[Path] | None = None) -> None:
        self._config = config
        self._workspace_roots = workspace_roots
        self._chunks: list[_Chunk] = []
        self._bm25: BM25Plus | None = None
        self._estimated_bytes = 0

        self._splitter = OverlappingTextSplitter(
            chunk_size=config.retriever.chunk_size,
            chunk_overlap=config.retriever.chunk_overlap,
        )

        self._index_files()

    @property
    def is_empty(self) -> bool:
        return len(self._chunks) == 0

    @property
    def chunk_count(self) -> int:
        return len(self._chunks)

    @property
    def estimated_resident_bytes(self) -> int:
        """Conservative estimate including chunk text and BM25 token maps."""
        return self._estimated_bytes

    def search(
        self,
        query: str,
        top_k: int | None = None,
        *,
        source_file: str | None = None,
    ) -> list[RetrievedChunk]:
        """Return top-k chunks matching *query* via BM25.

        Parameters
        ----------
        source_file :
            When set, only chunks from matching indexed paths are considered.
            Matching is path-suffix / basename based so callers can pass a
            workspace-relative path, absolute path, or bare filename.
        """
        if self._bm25 is None or self.is_empty:
            return []

        k = top_k if top_k is not None else self._config.retriever.top_k
        tokens = _tokenize(query)
        if not tokens:
            return []
        scores = self._bm25.get_scores(tokens)

        # Filter candidates *before* top-k so a single-file query is not
        # crowded out by higher-scoring chunks from other files.
        if source_file:
            candidate_idxs = [
                i
                for i in range(len(scores))
                if source_file_matches(self._chunks[i].source_file, source_file)
            ]
        else:
            candidate_idxs = list(range(len(scores)))

        ranked_idxs = sorted(
            candidate_idxs, key=lambda i: scores[i], reverse=True
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

        logger.info(
            "BM25 search for '%s'%s returned %d chunks",
            query,
            f" in '{source_file}'" if source_file else "",
            len(results),
        )
        return results

    # ── Indexing ────────────────────────────────────────────────────────

    MAX_CHUNKS_PER_FILE = 5000    # Per-file cap for text/pdf files
    MAX_CHUNKS_PER_CSV = 5000     # Per-file cap for CSV (1 chunk per row)
    MAX_CHARS_PER_CSV_ROW = 800   # Truncate long CSV rows to avoid index bloat

    def _index_files(self) -> None:
        """Read, chunk, and index local text/JSON/CSV/PDF files."""
        raw_texts: list[_Chunk] = []
        total_bytes = 0
        max_index_bytes = self._config.retriever.max_index_bytes
        max_chunks = self._config.retriever.max_chunks

        for root in self._candidate_roots():
            for fpath in self._iter_supported_files(root):
                if total_bytes >= max_index_bytes or len(raw_texts) >= max_chunks:
                    logger.warning(
                        "Indexing limit reached (%d MB / %d chunks). Skipping remaining files.",
                        total_bytes // (1024 * 1024), len(raw_texts)
                    )
                    break

                new_chunks = self._read_file_safe(fpath, root)
                # Per-file cap: prevents a single massive file from exhausting the index
                suffix = fpath.suffix.lower()
                per_file_cap = self.MAX_CHUNKS_PER_CSV if suffix == ".csv" else self.MAX_CHUNKS_PER_FILE
                new_chunks = new_chunks[:per_file_cap]
                added = 0
                for c in new_chunks:
                    total_bytes += len(c.text)
                    raw_texts.append(c)
                    added += 1
                    if len(raw_texts) >= max_chunks:
                        break
                if added:
                    logger.debug("Indexed %d chunks from %s", added, fpath.name)

            if total_bytes >= max_index_bytes or len(raw_texts) >= max_chunks:
                break

        if not raw_texts:
            logger.info("No text/JSON/CSV files found to index.")
            return

        corpus: list[list[str]] = []
        filtered_chunks: list[_Chunk] = []
        for chunk in raw_texts:
            # Paths often carry the strongest signal in code/data workspaces
            # (for example ``auth/session_store.py``).  Index them alongside
            # the body so callers do not have to know to use ``source_file``.
            tokens = _tokenize(chunk.text) + _tokenize(chunk.source_file)
            if not tokens:
                continue
            filtered_chunks.append(chunk)
            corpus.append(tokens)
        if not corpus:
            logger.info("No tokenizable chunks found for BM25.")
            return

        self._chunks = filtered_chunks
        # BM25Plus keeps useful positive scores for tiny workspaces where
        # Okapi's IDF can collapse every match to zero.
        self._bm25 = BM25Plus(corpus)
        self._estimated_bytes = total_bytes * 3 + len(self._chunks) * 512
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
            elif suffix == ".pdf":
                return self._read_pdf_file(fpath, root)
        except Exception as exc:
            logger.debug("Failed to read %s for indexing: %s", fpath, exc)
        return []

    def _candidate_roots(self) -> list[Path]:
        """Return deduplicated roots to scan for data files."""
        # When explicit roots are provided (multi-user mode), skip config discovery.
        if self._workspace_roots is not None:
            seen: set[Path] = set()
            result: list[Path] = []
            for r in self._workspace_roots:
                r = Path(r).resolve()
                if r not in seen and r.exists():
                    seen.add(r)
                    result.append(r)
            return result

        roots: list[Path] = []

        # Config-derived roots (if present)
        for key in self._config.data_paths.keys():
            try:
                p = self._config.get_path(key)
            except KeyError:
                continue
            base = p if p.is_dir() else p.parent
            roots.append(self._normalize_root(base))

        # Always scan known workspace subdirectories (data/, pdfs/, docs/, reports/)
        workspace = self._normalize_root(self._config._config_dir)
        for subdir_name in ("pdfs", "docs", "reports", "data", "."):
            candidate = workspace / subdir_name if subdir_name != "." else workspace
            if candidate.is_dir():
                roots.append(candidate)

        # Fallback to project cwd
        roots.append(workspace)

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
            elif suffix == ".pdf":
                chunks.extend(self._read_pdf_file(fpath, root))
        return chunks

    def _iter_supported_files(self, root: Path):
        """Yield supported files while skipping heavy/system folders."""
        supported_exts = {".txt", ".md", ".json", ".csv", ".pdf"}
        skip_dirs = {
            ".git", ".scout", ".scout-cache", "__pycache__", ".venv", "venv",
            "node_modules", ".mypy_cache", ".pytest_cache", ".local", ".mplconfig",
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
                    # Prevent deep recursion and symlink loops
                    if entry.is_symlink():
                        continue
                    if len(current.parts) - len(root.parts) > 10:
                        continue
                    stack.append(entry)
                    continue
                if entry.suffix.lower() in supported_exts:
                    # Avoid huge files that hurt startup/search quality.
                    try:
                        if entry.stat().st_size <= 100_000_000:
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
            return self._process_json_records(data, source_file, src_config)

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

    def _read_pdf_file(self, fpath: Path, root: Path) -> list[_Chunk]:
        """Read a PDF file and extract text for indexing."""
        try:
            import fitz
        except ImportError:
            logger.warning("pymupdf not installed, skipping PDF: %s", fpath)
            return []

        chunks: list[_Chunk] = []
        try:
            with fitz.open(fpath) as doc:
                text_parts = []
                for page in doc:
                    text_parts.append(page.get_text())
                full_text = "\n\n".join(text_parts)
                if full_text.strip():
                    chunks.extend(self._split_text(full_text, self._source_name(fpath, root)))
        except Exception as exc:
            logger.error("Error indexing PDF %s: %s", fpath, exc)
        return chunks

    def _read_csv_file(self, fpath: Path, root: Path) -> list[_Chunk]:
        """Read a CSV and index rows as textual records.

        Strategy: one chunk per row, truncated to MAX_CHARS_PER_CSV_ROW.
        This ensures all rows across a large file are represented.
        """
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
                    # One chunk per row, truncated — ensures full row coverage
                    row_text = row_text[:self.MAX_CHARS_PER_CSV_ROW]
                    chunks.append(
                        _Chunk(
                            source_file=source_file,
                            text=row_text,
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
        """Split text/PDF content at natural boundaries with overlap."""
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
    """Tokenize prose, paths, and common source-code identifiers.

    Keep the full alphanumeric form while also splitting camelCase/PascalCase
    and punctuation-delimited names.  This lets a query for ``live sessions``
    match ``maxLiveSessions`` without weakening exact identifier matches.
    """
    tokens: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9]+", text):
        full = raw.lower()
        tokens.append(full)
        parts = re.findall(
            r"[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[0-9]+",
            raw,
        )
        lowered_parts = [part.lower() for part in parts]
        if len(lowered_parts) > 1 or lowered_parts != [full]:
            tokens.extend(lowered_parts)
    return tokens


def source_file_matches(indexed: str, requested: str) -> bool:
    """Return True when an indexed source path refers to the requested file.

    Accepts workspace-relative paths, absolute paths, or bare filenames.
    Comparison is case-sensitive on the path body but tolerant of ``\\`` vs
    ``/`` and leading ``./``.
    """
    a = indexed.replace("\\", "/").strip().lstrip("./")
    b = requested.replace("\\", "/").strip().lstrip("./")
    if not a or not b:
        return False
    if a == b:
        return True
    # Absolute / longer path ends with the shorter relative path.
    if a.endswith("/" + b) or b.endswith("/" + a):
        return True
    # Bare filename: match any indexed path with that name.
    b_name = Path(b).name
    a_name = Path(a).name
    if "/" not in b and a_name == b_name:
        return True
    # Absolute path whose basename + trailing relative segment align.
    if a_name == b_name and (b.endswith("/" + a) or b.endswith(a)):
        return True
    return False


class RetrieverProxy:
    """Shared BM25 retriever for one user, lazily rebuilt when dirty.

    All sessions belonging to the same user reference the same proxy.
    Mark it dirty after any file change; the next ``search()`` or explicit
    ``rebuild_if_dirty()`` call will rebuild the inner index transparently.
    """

    def __init__(
        self,
        workspace_roots: list[Path],
        config: AppConfig,
        *,
        build_semaphore: threading.BoundedSemaphore | None = None,
        before_rebuild: Callable[[], None] | None = None,
    ) -> None:
        self._workspace_roots = workspace_roots
        self._config = config
        self._inner: BM25Retriever | object | None = None
        self._lock = threading.RLock()
        self._build_semaphore = build_semaphore
        self._before_rebuild = before_rebuild
        self._last_access = time.monotonic()
        self.dirty = True  # starts dirty; built on first use

    @property
    def is_empty(self) -> bool:
        with self._lock:
            return self._inner is None or self._inner.is_empty

    @property
    def is_resident(self) -> bool:
        with self._lock:
            return self._inner is not None

    @property
    def last_access(self) -> float:
        with self._lock:
            return self._last_access

    @property
    def chunk_count(self) -> int:
        with self._lock:
            return self._inner.chunk_count if self._inner else 0

    @property
    def estimated_resident_bytes(self) -> int:
        with self._lock:
            return self._inner.estimated_resident_bytes if self._inner else 0

    def touch(self) -> None:
        with self._lock:
            self._last_access = time.monotonic()

    def search(
        self,
        query: str,
        top_k: int | None = None,
        *,
        source_file: str | None = None,
    ) -> list[RetrievedChunk]:
        self._ensure_built()
        with self._lock:
            self._last_access = time.monotonic()
            return self._inner.search(  # type: ignore[union-attr]
                query, top_k, source_file=source_file
            )

    def mark_dirty(self) -> None:
        with self._lock:
            self.dirty = True

    def rebuild_if_dirty(self) -> None:
        self._ensure_built()

    def _ensure_built(self) -> None:
        """Build lazily, invoking capacity management without lock inversion."""
        with self._lock:
            needs_rebuild = self.dirty or self._inner is None
        if not needs_rebuild:
            return
        if self._before_rebuild is not None:
            self._before_rebuild()
        with self._lock:
            if self.dirty or self._inner is None:
                self._rebuild_locked()

    def evict(self) -> int:
        """Release the resident index; it will rebuild transparently on use."""
        with self._lock:
            released = self.estimated_resident_bytes
            self._inner = None
            return released

    def _rebuild_locked(self) -> None:
        logger.info("Building BM25 index for user (roots: %s)", self._workspace_roots)
        # Drop a stale index before constructing its replacement so a rebuild
        # does not temporarily double the user's resident memory.
        self._inner = None
        if self._build_semaphore is None:
            inner = _make_retriever(self._config, self._workspace_roots)
        else:
            with self._build_semaphore:
                inner = _make_retriever(self._config, self._workspace_roots)
        self._inner = inner
        self.dirty = False
        self._last_access = time.monotonic()


def _make_retriever(config: AppConfig, workspace_roots: list[Path]):
    """Select the server-side retrieval backend; this is not agent-controlled."""
    if config.retriever.backend == "sqlite_fts5":
        from .fts_retriever import SQLiteFTSRetriever
        try:
            return SQLiteFTSRetriever(config, workspace_roots=workspace_roots)
        except Exception:
            logger.exception("SQLite FTS5 unavailable; falling back to in-memory BM25")
    return BM25Retriever(config, workspace_roots=workspace_roots)


def evict_retriever_proxies(
    proxies: dict[str, RetrieverProxy],
    *,
    idle_ttl_seconds: float,
    max_resident: int,
    exclude_user: str | None = None,
    reserve: int = 0,
    now: float | None = None,
) -> EvictionReport:
    """Evict idle indexes first, then LRU indexes to satisfy a hard cap.

    Proxy objects remain registered so sessions holding a proxy reload the
    same index transparently on their next search.
    """
    current_time = time.monotonic() if now is None else now
    released = 0
    evicted: list[str] = []
    for user_id, proxy in proxies.items():
        if (
            user_id != exclude_user
            and proxy.is_resident
            and current_time - proxy.last_access >= idle_ttl_seconds
        ):
            released += proxy.evict()
            evicted.append(user_id)

    resident = [
        (user_id, proxy)
        for user_id, proxy in proxies.items()
        if proxy.is_resident and user_id != exclude_user
    ]
    allowed_others = max(0, max_resident - reserve)
    if len(resident) > allowed_others:
        resident.sort(key=lambda item: item[1].last_access)
        for user_id, proxy in resident[: len(resident) - allowed_others]:
            released += proxy.evict()
            evicted.append(user_id)

    return {
        "users": evicted,
        "released_bytes": released,
        "resident_users": sum(proxy.is_resident for proxy in proxies.values()),
    }
