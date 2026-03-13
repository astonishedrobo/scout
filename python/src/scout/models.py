"""Pydantic data models for the Scout agent framework."""

from __future__ import annotations

from pydantic import BaseModel, Field


class RetrievedChunk(BaseModel):
    """A text chunk retrieved via BM25."""

    source_file: str = Field(..., description="File the chunk came from")
    text: str = Field(..., description="The retrieved text content")
    score: float = Field(0.0, description="BM25 relevance score")
    source_type: str = Field(
        "text",
        description="Source type: 'text' for text/PDF files, 'json' for JSON records",
    )
    record_index: int | None = Field(
        None,
        description="Array index of the JSON record (None for text/PDF chunks)",
    )
    metadata: dict[str, str] | None = Field(
        None,
        description="Structured metadata from the JSON record (None for text/PDF chunks)",
    )
