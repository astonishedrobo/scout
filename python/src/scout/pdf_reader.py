"""PDF reading and conversion utilities for Scout.

This module provides two capabilities:

1. **PDFConverter** — Batch-converts PDFs to text/markdown and caches
   them on disk.  Used at init time so the BM25 retriever can index
   the resulting text files.

2. **extract_pdf_text()** — In-memory extraction for on-demand PDF
   reading (e.g. the ``read_pdf`` agent tool).  Nothing is saved to
   disk.  Supports page-range selection and BM25 search within the
   extracted text.

Two parser backends are supported (selectable via ``config.yaml``):

* **pdfplumber** — heuristic table extraction using line/cell geometry
  via *pdfplumber*, stitched with prose text from *pymupdf*.  Fast,
  lightweight, and great for PDFs with visible grid-line tables.
* **docling** — IBM's ML-based document converter using TableFormer
  for table structure recognition.  Single library handles prose,
  headings, lists, **and** tables in one pass.  Slower (~10-30 s per
  PDF) and heavier (~1 GB model download on first use), but produces
  the highest-quality markdown.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Supported parser names → (output extension, description)
_PARSERS: dict[str, tuple[str, str]] = {
    "pdfplumber": (".md", "heuristic tables (pdfplumber + pymupdf)"),
    "docling": (".md", "ML-based (IBM docling)"),
}


class PDFConverter:
    """Scan a PDF directory and cache extracted text in a text directory."""

    def __init__(
        self,
        pdf_dir: Path,
        text_dir: Path,
        parser: str = "pdfplumber",
    ) -> None:
        if parser not in _PARSERS:
            raise ValueError(
                f"Unknown PDF parser '{parser}'. "
                f"Choose from: {sorted(_PARSERS)}"
            )
        self._pdf_dir = pdf_dir
        self._text_dir = text_dir
        self._parser = parser
        self._ext = _PARSERS[parser][0]

    # ── Public API ───────────────────────────────────────────────────────

    def convert_all(self, max_conversions: int = 20) -> list[Path]:
        """Convert all new / stale PDFs and return paths of written files.

        Returns an empty list if ``pdf_dir`` does not exist or contains
        no PDFs.
        """
        if not self._pdf_dir.is_dir():
            logger.info(
                "PDF directory does not exist: %s — skipping.", self._pdf_dir
            )
            return []

        pdf_files = sorted(self._pdf_dir.glob("*.pdf"))
        if not pdf_files:
            logger.info("No PDFs found in %s.", self._pdf_dir)
            return []

        # Ensure text_dir exists so we can write cached files
        self._text_dir.mkdir(parents=True, exist_ok=True)

        written: list[Path] = []
        for pdf_path in pdf_files:
            if len(written) >= max_conversions:
                logger.warning(
                    "PDF conversion limit reached (%d). Skipping remaining PDFs.",
                    max_conversions
                )
                break

            out_path = self._text_dir / f"{pdf_path.stem}{self._ext}"

            if self._is_cache_fresh(pdf_path, out_path):
                logger.debug(
                    "Cache is fresh for %s — skipping.", pdf_path.name
                )
                continue

            text = self._extract(pdf_path)
            if text.strip():
                out_path.write_text(text, encoding="utf-8")
                written.append(out_path)
                logger.info(
                    "Converted %s → %s [%s] (%d chars)",
                    pdf_path.name,
                    out_path.name,
                    self._parser,
                    len(text),
                )
            else:
                logger.warning(
                    "PDF %s produced empty text — skipped.", pdf_path.name
                )

        logger.info(
            "PDF conversion complete (%s): %d converted, %d already cached.",
            self._parser,
            len(written),
            len(pdf_files) - len(written) if len(pdf_files) > len(written) else 0,
        )
        return written

    # ── Internals ────────────────────────────────────────────────────────

    @staticmethod
    def _is_cache_fresh(pdf_path: Path, out_path: Path) -> bool:
        """Return True if the cached file exists and is newer than the PDF."""
        if not out_path.exists():
            return False
        return out_path.stat().st_mtime >= pdf_path.stat().st_mtime

    def _extract(self, pdf_path: Path) -> str:
        """Dispatch to the configured parser backend."""
        dispatch = {
            "docling": self._extract_docling,
            "pdfplumber": self._extract_pdfplumber,
        }
        return dispatch[self._parser](pdf_path)

    # ── docling (ML-based document conversion) ──────────────────────────

    @staticmethod
    def _extract_docling(pdf_path: Path) -> str:
        """High-quality markdown via IBM docling (TableFormer for tables).

        Requires ``pip install docling``.  On first use it downloads
        ML models (~1 GB).  Slower than pdfplumber but produces the
        best table structure.
        """
        try:
            from docling.document_converter import DocumentConverter
        except ImportError as exc:
            raise ImportError(
                "docling is required for ML-based PDF conversion. "
                "Install it with: pip install docling"
            ) from exc

        converter = DocumentConverter()
        result = converter.convert(str(pdf_path))
        return result.document.export_to_markdown()

    # ── pdfplumber (heuristic tables + pymupdf prose) ───────────────────

    @classmethod
    def _extract_pdfplumber(cls, pdf_path: Path) -> str:
        """Stitch pdfplumber table extraction with pymupdf prose text.

        For each page:
        1. Detect tables via ``pdfplumber`` (heuristic line/cell geometry).
        2. Convert each table to a markdown ``| col | col |`` block.
        3. Extract non-table text from ``pymupdf`` (fitz), clipping
           regions that overlap with detected tables.
        4. Interleave prose and tables in top-to-bottom reading order.

        Requires ``pip install pdfplumber pymupdf``.
        """
        try:
            import pdfplumber
        except ImportError as exc:
            raise ImportError(
                "pdfplumber is required for heuristic table extraction. "
                "Install it with: pip install pdfplumber"
            ) from exc
        try:
            import fitz  # pymupdf
        except ImportError as exc:
            raise ImportError(
                "pymupdf is required for prose text extraction. "
                "Install it with: pip install pymupdf"
            ) from exc

        page_outputs: list[str] = []

        with (
            pdfplumber.open(pdf_path) as plumber_doc,
            fitz.open(pdf_path) as fitz_doc,
        ):
            for page_idx in range(len(fitz_doc)):
                plumber_page = plumber_doc.pages[page_idx]
                fitz_page = fitz_doc[page_idx]

                tables = plumber_page.find_tables()

                if not tables:
                    # No tables — use full fitz plain text for the page
                    text = fitz_page.get_text()
                    if text.strip():
                        page_outputs.append(text)
                    continue

                # Collect table bounding boxes and their markdown
                # Each entry: (top_y, markdown_str)
                table_entries: list[tuple[float, str]] = []
                table_bboxes: list[tuple[float, float, float, float]] = []

                for table in tables:
                    bbox = table.bbox  # (x0, top, x1, bottom)
                    table_bboxes.append(bbox)

                    rows = table.extract()
                    md = cls._rows_to_markdown(rows)
                    if md:
                        table_entries.append((bbox[1], md))  # top_y, markdown

                # Extract non-table text from fitz by clipping table regions
                prose = cls._extract_prose_excluding_tables(
                    fitz_page, table_bboxes
                )

                # Interleave prose and tables by vertical position
                parts: list[tuple[float, str]] = []
                if prose.strip():
                    parts.append((0.0, prose))
                parts.extend(table_entries)

                # Sort by vertical position (top to bottom)
                parts.sort(key=lambda p: p[0])

                page_text = "\n\n".join(text for _, text in parts)
                if page_text.strip():
                    page_outputs.append(page_text)

        return "\n\n".join(page_outputs)

    # ── pdfplumber helpers ───────────────────────────────────────────────

    @staticmethod
    def _rows_to_markdown(rows: list[list[str | None]]) -> str:
        """Convert a list of table rows into a markdown table string.

        ``rows`` comes from ``pdfplumber``'s ``table.extract()`` which
        returns a list of lists (rows x columns).  The first row is
        treated as the header.
        """
        if not rows:
            return ""

        def _clean(cell: str | None) -> str:
            if cell is None:
                return ""
            # Collapse whitespace, strip, and escape pipes
            return " ".join(cell.split()).replace("|", "\\|")

        cleaned = [[_clean(c) for c in row] for row in rows]

        # Ensure all rows have the same number of columns
        max_cols = max(len(r) for r in cleaned) if cleaned else 0
        if max_cols == 0:
            return ""
        for row in cleaned:
            while len(row) < max_cols:
                row.append("")

        lines: list[str] = []
        # Header row
        header = "| " + " | ".join(cleaned[0]) + " |"
        separator = "| " + " | ".join("---" for _ in range(max_cols)) + " |"
        lines.append(header)
        lines.append(separator)

        # Data rows
        for row in cleaned[1:]:
            lines.append("| " + " | ".join(row) + " |")

        return "\n".join(lines)

    @staticmethod
    def _extract_prose_excluding_tables(
        fitz_page: "fitz.Page",  # type: ignore[name-defined]
        table_bboxes: list[tuple[float, float, float, float]],
    ) -> str:
        """Extract text from a fitz page, excluding table regions.

        ``table_bboxes`` is a list of ``(x0, top, x1, bottom)`` tuples
        from pdfplumber.  We get text blocks from fitz and filter out
        any whose vertical midpoint falls inside a table region.
        """
        blocks = fitz_page.get_text("blocks")  # list of (x0, y0, x1, y1, text, ...)
        kept: list[str] = []

        for block in blocks:
            bx0, by0, bx1, by1 = block[:4]
            block_mid_y = (by0 + by1) / 2.0

            in_table = False
            for tx0, ttop, tx1, tbottom in table_bboxes:
                if ttop <= block_mid_y <= tbottom:
                    in_table = True
                    break

            if not in_table:
                text = block[4] if len(block) > 4 else ""
                if isinstance(text, str) and text.strip():
                    kept.append(text.strip())

        return "\n".join(kept)


# ── In-memory extraction (for the read_pdf agent tool) ───────────────────


def extract_pdf_text(
    pdf_path: str | Path,
    pages: str = "",
    parser: str = "pdfplumber",
) -> tuple[str, int]:
    """Extract text from a PDF **without** writing anything to disk.

    Parameters
    ----------
    pdf_path : str | Path
        Path to the PDF file.
    pages : str
        Page range to extract (e.g. ``"1-5"``, ``"3,7,12"``).
        Empty string means all pages.  Pages are 1-indexed.
    parser : str
        ``"pdfplumber"`` or ``"docling"``.

    Returns
    -------
    text : str
        Extracted text (markdown for pdfplumber/docling).
    total_pages : int
        Total number of pages in the PDF.
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    converter = PDFConverter.__new__(PDFConverter)
    converter._parser = parser
    converter._ext = _PARSERS.get(parser, (".md",))[0]

    if parser == "docling":
        # Docling processes the whole document; page filtering is not
        # easily supported so we extract all and slice later.
        full_text = converter._extract_docling(pdf_path)
        total_pages = _count_pages(pdf_path)
        if pages:
            # For docling we can't easily page-slice the markdown,
            # so return it all (the caller truncates by max_chars).
            return full_text, total_pages
        return full_text, total_pages

    # pdfplumber: per-page extraction supports page ranges
    try:
        import pdfplumber
    except ImportError as exc:
        raise ImportError("pdfplumber is required: pip install pdfplumber") from exc
    try:
        import fitz
    except ImportError as exc:
        raise ImportError("pymupdf is required: pip install pymupdf") from exc

    with pdfplumber.open(pdf_path) as plumber_doc, fitz.open(pdf_path) as fitz_doc:
        total_pages = len(fitz_doc)
        page_indices = _parse_page_range(pages, total_pages) if pages else list(range(total_pages))

        page_outputs: list[str] = []
        for idx in page_indices:
            if idx < 0 or idx >= total_pages:
                continue
            plumber_page = plumber_doc.pages[idx]
            fitz_page = fitz_doc[idx]

            tables = plumber_page.find_tables()
            if not tables:
                text = fitz_page.get_text()
                if text.strip():
                    page_outputs.append(text)
                continue

            table_entries: list[tuple[float, str]] = []
            table_bboxes: list[tuple[float, float, float, float]] = []
            for table in tables:
                bbox = table.bbox
                table_bboxes.append(bbox)
                rows = table.extract()
                md = PDFConverter._rows_to_markdown(rows)
                if md:
                    table_entries.append((bbox[1], md))

            prose = PDFConverter._extract_prose_excluding_tables(fitz_page, table_bboxes)
            parts: list[tuple[float, str]] = []
            if prose.strip():
                parts.append((0.0, prose))
            parts.extend(table_entries)
            parts.sort(key=lambda p: p[0])
            page_text = "\n\n".join(t for _, t in parts)
            if page_text.strip():
                page_outputs.append(page_text)

    return "\n\n".join(page_outputs), total_pages


def search_pdf_text(
    full_text: str,
    query: str,
    top_k: int = 5,
    chunk_size: int = 800,
    chunk_overlap: int = 100,
) -> list[str]:
    """BM25-search over in-memory PDF text, returning the top-k chunks.

    This creates a temporary index each time — suitable for ad-hoc
    searches on attached PDFs, not for large-scale retrieval.
    """
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    from rank_bm25 import BM25Okapi

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
        keep_separator=True,
    )
    chunks = splitter.split_text(full_text)
    if not chunks:
        return []

    tokenized = [c.lower().split() for c in chunks]
    bm25 = BM25Okapi(tokenized)
    scores = bm25.get_scores(query.lower().split())

    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
    return [chunks[i] for i in ranked if scores[i] > 0]


def _count_pages(pdf_path: Path) -> int:
    """Return the number of pages in a PDF (uses fitz/pymupdf)."""
    try:
        import fitz
        with fitz.open(pdf_path) as doc:
            return len(doc)
    except Exception:
        return 0


def _parse_page_range(pages_str: str, total: int) -> list[int]:
    """Parse a page range string (1-indexed) into 0-indexed indices.

    Supports: ``"1-5"``, ``"3,7,12"``, ``"1-3,7"``.
    """
    indices: list[int] = []
    for part in pages_str.split(","):
        part = part.strip()
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start = max(1, int(start_s.strip()))
            end = min(total, int(end_s.strip()))
            indices.extend(range(start - 1, end))
        else:
            idx = int(part) - 1
            if 0 <= idx < total:
                indices.append(idx)
    return sorted(set(indices))
