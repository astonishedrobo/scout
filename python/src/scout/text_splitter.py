"""Small boundary-aware text splitter for retrieval indexes."""

from __future__ import annotations


class OverlappingTextSplitter:
    """Split text near natural boundaries with a bounded character overlap."""

    def __init__(self, chunk_size: int, chunk_overlap: int) -> None:
        if chunk_size < 1:
            raise ValueError("chunk_size must be positive")
        if chunk_overlap < 0 or chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be smaller than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def split_text(self, text: str) -> list[str]:
        text = text.strip()
        if not text:
            return []
        if len(text) <= self.chunk_size:
            return [text]

        chunks: list[str] = []
        start = 0
        length = len(text)
        separators = ("\n\n", "\n", ". ", " ")
        minimum_chunk = max(1, self.chunk_size // 2)

        while start < length:
            hard_end = min(length, start + self.chunk_size)
            end = hard_end
            if hard_end < length:
                search_start = min(hard_end, start + minimum_chunk)
                for separator in separators:
                    boundary = text.rfind(separator, search_start, hard_end)
                    if boundary >= search_start:
                        end = boundary + len(separator)
                        break

            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            if end >= length:
                break
            next_start = max(start + 1, end - self.chunk_overlap)
            # Avoid beginning the next chunk in the middle of whitespace.
            while next_start < end and text[next_start].isspace():
                next_start += 1
            start = next_start

        return chunks
