"""Persistent, disk-backed ranked lexical retrieval using SQLite FTS5."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import time
import uuid
from pathlib import Path

from .config import AppConfig
from .models import RetrievedChunk
from .retriever import BM25Retriever, source_file_matches

logger = logging.getLogger(__name__)

_SCHEMA_VERSION = "1"


class SQLiteFTSRetriever(BM25Retriever):
    """BM25-ranked FTS index persisted in a user's internal cache directory.

    Only search results enter process memory. The full inverted index remains
    on disk and is reused while the source-file manifest is unchanged.
    """

    def __init__(self, config: AppConfig, workspace_roots: list[Path]) -> None:
        self._db_path: Path | None = None
        self._chunk_count = 0
        self._db_bytes = 0
        self._manifest = ""
        super().__init__(config, workspace_roots=workspace_roots)

    @property
    def is_empty(self) -> bool:
        return self._chunk_count == 0

    @property
    def chunk_count(self) -> int:
        return self._chunk_count

    @property
    def estimated_resident_bytes(self) -> int:
        # Queries open short-lived SQLite connections; the index is not held
        # by this object. Report a conservative small working-set allowance.
        return min(self._db_bytes, 256 * 1024) if self._db_bytes else 0

    @property
    def index_disk_bytes(self) -> int:
        return self._db_bytes

    def _index_files(self) -> None:
        roots = self._candidate_roots()
        if not roots:
            return
        cache = roots[0] / ".scout-cache"
        cache.mkdir(parents=True, exist_ok=True)
        self._db_path = cache / "retrieval-fts5-v1.sqlite3"

        files: list[tuple[Path, Path]] = []
        seen: set[Path] = set()
        manifest_parts = [
            _SCHEMA_VERSION,
            str(self._config.retriever.chunk_size),
            str(self._config.retriever.chunk_overlap),
        ]
        for root in roots:
            for path in self._iter_supported_files(root):
                # Structured tables are queried directly by filter_table. Do
                # not duplicate potentially huge CSV row stores in FTS.
                if path.suffix.lower() == ".csv":
                    continue
                resolved = path.resolve()
                if resolved in seen:
                    continue
                seen.add(resolved)
                try:
                    stat = resolved.stat()
                except OSError:
                    continue
                files.append((resolved, root))
                manifest_parts.append(
                    f"{resolved}\0{stat.st_size}\0{stat.st_mtime_ns}"
                )
        self._manifest = hashlib.sha256("\n".join(manifest_parts).encode()).hexdigest()

        if self._load_if_fresh():
            logger.info(
                "Reused SQLite FTS5 index with %d chunks (%d KB on disk)",
                self._chunk_count,
                self._db_bytes // 1024,
            )
            return

        started = time.monotonic()
        temp = self._db_path.with_name(f".{self._db_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            connection = sqlite3.connect(temp)
            connection.execute("PRAGMA journal_mode=OFF")
            connection.execute("PRAGMA synchronous=OFF")
            connection.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute(
                "CREATE VIRTUAL TABLE chunks USING fts5("
                "source_file UNINDEXED, text, source_type UNINDEXED, "
                "record_index UNINDEXED, metadata UNINDEXED, "
                "tokenize='unicode61', prefix='4 6 8')"
            )
            count = 0
            with connection:
                for path, root in files:
                    chunks = self._read_file_safe(path, root)
                    suffix = path.suffix.lower()
                    cap = self.MAX_CHUNKS_PER_CSV if suffix == ".csv" else self.MAX_CHUNKS_PER_FILE
                    rows = []
                    for chunk in chunks[:cap]:
                        if not chunk.text.strip():
                            continue
                        rows.append((
                            chunk.source_file,
                            chunk.text,
                            chunk.source_type,
                            chunk.record_index,
                            json.dumps(chunk.metadata, separators=(",", ":"))
                            if chunk.metadata else None,
                        ))
                    connection.executemany(
                        "INSERT INTO chunks(source_file,text,source_type,record_index,metadata) "
                        "VALUES (?,?,?,?,?)",
                        rows,
                    )
                    count += len(rows)
                connection.executemany(
                    "INSERT INTO meta(key,value) VALUES (?,?)",
                    (("manifest", self._manifest), ("chunk_count", str(count))),
                )
            connection.execute("INSERT INTO chunks(chunks) VALUES ('optimize')")
            connection.close()
            temp.replace(self._db_path)
        finally:
            temp.unlink(missing_ok=True)

        self._chunk_count = count
        self._db_bytes = self._db_path.stat().st_size
        logger.info(
            "Built SQLite FTS5 index with %d chunks (%d KB on disk) in %.2fs",
            count,
            self._db_bytes // 1024,
            time.monotonic() - started,
        )

    def _load_if_fresh(self) -> bool:
        if self._db_path is None or not self._db_path.is_file():
            return False
        try:
            with sqlite3.connect(self._db_path) as connection:
                metadata = dict(connection.execute("SELECT key,value FROM meta"))
            if metadata.get("manifest") != self._manifest:
                return False
            self._chunk_count = int(metadata.get("chunk_count", "0"))
            self._db_bytes = self._db_path.stat().st_size
            return True
        except (OSError, sqlite3.Error, ValueError):
            return False

    def search(
        self,
        query: str,
        top_k: int | None = None,
        *,
        source_file: str | None = None,
    ) -> list[RetrievedChunk]:
        if self._db_path is None or self.is_empty:
            return []
        terms = re.findall(r"[a-z0-9]+", query.lower())
        if not terms:
            return []
        # Prefix matching handles natural partial terms such as "vulnerab"
        # while retaining FTS5's BM25 lexical ranking.
        match = " OR ".join(f'"{term}"*' for term in dict.fromkeys(terms))
        k = max(1, min(top_k or self._config.retriever.top_k, 100))

        with sqlite3.connect(self._db_path) as connection:
            params: list[object] = [match]
            source_clause = ""
            if source_file:
                sources = [
                    row[0]
                    for row in connection.execute("SELECT DISTINCT source_file FROM chunks")
                    if source_file_matches(str(row[0]), source_file)
                ]
                if not sources:
                    return []
                placeholders = ",".join("?" for _ in sources)
                source_clause = f" AND source_file IN ({placeholders})"
                params.extend(sources)
            params.append(k)
            rows = connection.execute(
                "SELECT source_file,text,source_type,record_index,metadata,bm25(chunks) "
                f"FROM chunks WHERE chunks MATCH ?{source_clause} "
                "ORDER BY bm25(chunks) LIMIT ?",
                params,
            ).fetchall()

        results = []
        for source, text, source_type, record_index, metadata, score in rows:
            results.append(RetrievedChunk(
                source_file=str(source),
                text=str(text),
                score=float(-score),
                source_type=str(source_type or "text"),
                record_index=int(record_index) if record_index is not None else None,
                metadata=json.loads(metadata) if metadata else None,
            ))
        logger.info(
            "FTS5 search for '%s'%s returned %d chunks",
            query,
            f" in '{source_file}'" if source_file else "",
            len(results),
        )
        return results
