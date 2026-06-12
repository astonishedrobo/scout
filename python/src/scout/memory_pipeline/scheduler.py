"""Background scheduler for memory pipeline jobs."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from ..config import AppConfig
from .stage1 import run_stage1_batch
from .stage2 import run_stage2

logger = logging.getLogger(__name__)

_scheduled: set[str] = set()


def schedule_memory_pipeline(
    *,
    session_id: str,
    personal_dir: Path,
    server_mode: bool,
    sessions_dir: Path,
    config: AppConfig,
    user_id: str = "default",
) -> None:
    if not config.memories.generate_memories:
        return
    key = f"{user_id}:{session_id}"
    if key in _scheduled:
        return
    _scheduled.add(key)

    async def _run() -> None:
        try:
            await run_stage1_batch(
                sessions_dir,
                personal_dir=personal_dir,
                server_mode=server_mode,
                memories_config=config.memories,
                app_config=config,
            )
            await run_stage2(
                personal_dir=personal_dir,
                server_mode=server_mode,
                memories_config=config.memories,
                app_config=config,
                user_id=user_id,
            )
        except Exception:
            logger.exception("Memory pipeline failed for %s", key)
        finally:
            _scheduled.discard(key)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        pass
