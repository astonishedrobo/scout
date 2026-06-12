"""Standalone egress proxy entrypoint for the Compose sidecar."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os

from .network_proxy import EgressProxy

logger = logging.getLogger(__name__)


async def _run(host: str, port: int) -> None:
    domains = os.environ.get("SCOUT_EGRESS_ALLOWED_DOMAINS", "")
    allowed = {d.strip() for d in domains.split(",") if d.strip()}
    proxy = EgressProxy(allowed_domains=allowed, host=host, port=port)
    await proxy.start()
    logger.info("Scout egress proxy ready on %s:%s", host, port)
    try:
        await asyncio.Event().wait()
    finally:
        await proxy.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Scout egress proxy sidecar")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7892)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level))
    asyncio.run(_run(args.host, args.port))


if __name__ == "__main__":
    main()
