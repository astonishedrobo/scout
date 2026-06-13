"""Run the Scout agent server: ``python -m scout.server``."""

from __future__ import annotations

import argparse
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)


def _watch_parent(parent_pid: int) -> None:
    """Background thread that terminates the server if the Node.js parent dies."""
    while True:
        time.sleep(2)
        if os.getppid() != parent_pid:
            logger.warning(
                "Parent process %d gone — shutting down orphaned server",
                parent_pid,
            )
            os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Scout Agent Server")
    parser.add_argument(
        "--config",
        default=None,
        help="Path to a project config YAML (optional).",
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for the agent (defaults to cwd).",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7890)
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=0,
        help="PID of the Node.js parent process (for orphan detection).",
    )
    parser.add_argument(
        "--serve-gui",
        default=None,
        help="Path to pre-built GUI static files to serve.",
    )
    args = parser.parse_args()

    multi_user = os.environ.get("SCOUT_SERVER_DEPLOYMENT", "").lower() == "docker"
    if multi_user:
        from ..secrets import require_production_secret
        require_production_secret(
            "SCOUT_SECRET_KEY",
            {"fallback_secret_key_for_dev_only_please_change", "my-super-secret-jwt-key-change-me"},
        )

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    if args.parent_pid:
        watcher = threading.Thread(
            target=_watch_parent, args=(args.parent_pid,), daemon=True
        )
        watcher.start()

    import uvicorn
    from .app import create_app

    app = create_app(
        config_path=args.config,
        cwd=args.cwd,
        gui_static_dir=args.serve_gui,
        multi_user=multi_user,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level.lower())


if __name__ == "__main__":
    main()
