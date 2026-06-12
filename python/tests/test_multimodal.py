from pathlib import Path
from PIL import Image

from scout.agent.multimodal import build_human_message, image_paths


def test_image_paths_filters_non_images(tmp_path: Path):
    image = tmp_path / "screen.png"
    text = tmp_path / "notes.txt"
    image.write_bytes(b"png")
    text.write_text("text")
    assert image_paths([str(image), str(text)]) == [str(image.resolve())]


def test_build_human_message_contains_image_block(tmp_path: Path):
    image = tmp_path / "screen.png"
    Image.new("RGB", (2, 2), "red").save(image)
    message = build_human_message("inspect", [str(image)])
    assert message.content[0] == {"type": "text", "text": "inspect"}
    assert message.content[1]["type"] == "image_url"
