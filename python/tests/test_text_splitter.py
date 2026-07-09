from scout.text_splitter import OverlappingTextSplitter


def test_splitter_prefers_natural_boundaries_and_preserves_content():
    text = "First paragraph has useful context.\n\nSecond paragraph has the target phrase.\n\nThird paragraph closes."
    splitter = OverlappingTextSplitter(chunk_size=58, chunk_overlap=12)

    chunks = splitter.split_text(text)

    assert len(chunks) >= 2
    assert all(len(chunk) <= 58 for chunk in chunks)
    assert any("target phrase" in chunk for chunk in chunks)
    assert chunks[0].endswith("context.")


def test_splitter_validates_overlap():
    try:
        OverlappingTextSplitter(chunk_size=100, chunk_overlap=100)
    except ValueError as exc:
        assert "smaller" in str(exc)
    else:
        raise AssertionError("invalid overlap should fail")
