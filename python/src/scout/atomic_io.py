"""Atomic file write helpers.

Writes go to a same-directory temp file, then ``os.replace`` commits the
result.  If the process is cancelled mid-write the original target is left
unchanged (or still absent for creates).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_bytes(target: Path, data: bytes) -> None:
    """Write ``data`` to ``target`` atomically on the same filesystem."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(target.parent),
        prefix=f".{target.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def atomic_write_text(target: Path, text: str, encoding: str = "utf-8") -> None:
    """Write text to ``target`` atomically."""
    atomic_write_bytes(target, text.encode(encoding))
