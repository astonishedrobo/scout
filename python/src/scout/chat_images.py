"""Private, session-scoped chat image storage and prompt processing."""

from __future__ import annotations

import base64
import hashlib
import io
from functools import lru_cache
from pathlib import Path

from PIL import Image

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_DIMENSION = 2048
SUPPORTED_FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp")}


def asset_dir(session_dir: Path, session_id: str) -> Path:
    return session_dir / f"{session_id}.assets"


def validate_and_store(data: bytes, session_dir: Path, session_id: str, image_id: str) -> dict:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Image exceeds the 10 MB limit")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            fmt = image.format
            width, height = image.size
    except Exception as exc:
        raise ValueError("Invalid image") from exc
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError("Unsupported image format")
    ext, mime = SUPPORTED_FORMATS[fmt]
    target_dir = asset_dir(session_dir, session_id)
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = target_dir / f"{image_id}.{ext}"
    target.write_bytes(data)
    target.chmod(0o600)
    return {"id": image_id, "mime_type": mime, "width": width, "height": height, "size": len(data)}


def resolve_asset(session_dir: Path, session_id: str, image_id: str) -> Path:
    if not image_id or any(c not in "0123456789abcdef-" for c in image_id.lower()):
        raise FileNotFoundError(image_id)
    matches = list(asset_dir(session_dir, session_id).glob(f"{image_id}.*"))
    if len(matches) != 1 or not matches[0].is_file():
        raise FileNotFoundError(image_id)
    return matches[0]


@lru_cache(maxsize=32)
def _processed_data_url(path: str, digest: str) -> str:
    data = Path(path).read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        fmt = image.format if image.format in SUPPORTED_FORMATS else "PNG"
        if max(image.size) > MAX_DIMENSION:
            image.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.BILINEAR)
            out = io.BytesIO()
            if fmt == "JPEG" and image.mode not in {"RGB", "L"}:
                image = image.convert("RGB")
            image.save(out, format=fmt)
            data = out.getvalue()
        mime = SUPPORTED_FORMATS[fmt][1]
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def processed_data_url(path: Path) -> str:
    data = path.read_bytes()
    return _processed_data_url(str(path), hashlib.sha1(data).hexdigest())


def resolve_assets(session_dir: Path, session_id: str, image_ids: list[str] | None) -> list[Path]:
    return [resolve_asset(session_dir, session_id, image_id) for image_id in (image_ids or [])]
