from pathlib import Path

from PIL import Image

from scout.chat_images import MAX_DIMENSION, processed_data_url, resolve_asset, validate_and_store


def png_bytes(width: int, height: int) -> bytes:
    import io
    out = io.BytesIO()
    Image.new("RGB", (width, height), "red").save(out, format="PNG")
    return out.getvalue()


def test_private_image_store_and_resolve(tmp_path: Path):
    meta = validate_and_store(png_bytes(10, 20), tmp_path, "session", "abc-123")
    assert meta["width"] == 10
    assert resolve_asset(tmp_path, "session", "abc-123").parent.name == "session.assets"


def test_large_image_is_resized_for_prompt(tmp_path: Path):
    validate_and_store(png_bytes(MAX_DIMENSION + 10, 10), tmp_path, "session", "abc-123")
    path = resolve_asset(tmp_path, "session", "abc-123")
    assert processed_data_url(path).startswith("data:image/png;base64,")
