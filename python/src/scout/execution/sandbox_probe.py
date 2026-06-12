"""Startup probes proving bubblewrap and namespace isolation work."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .launcher import bwrap_available

logger = logging.getLogger(__name__)

_BWRAP_PATH = shutil.which("bwrap")


@dataclass
class SandboxProbeResult:
    available: bool
    isolation: bool
    bwrap_path: str | None = None
    persistent_python: bool = False
    oneshot: bool = False
    error: str | None = None
    warnings: list[str] = field(default_factory=list)


def _run_probe(command: list[str], *, timeout: int = 10) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode == 0, output.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def probe_sandbox_isolation() -> SandboxProbeResult:
    """Actively verify bwrap can isolate user processes."""
    if not bwrap_available() or not _BWRAP_PATH:
        return SandboxProbeResult(
            available=False,
            isolation=False,
            error="bubblewrap (bwrap) not found",
        )

    bwrap_real = str(Path(_BWRAP_PATH).resolve())
    if not os.access(bwrap_real, os.X_OK):
        return SandboxProbeResult(
            available=False,
            isolation=False,
            bwrap_path=bwrap_real,
            error=f"bwrap not executable: {bwrap_real}",
        )

    warnings: list[str] = []

    ok, out = _run_probe([bwrap_real, "--version"])
    if not ok:
        return SandboxProbeResult(
            available=False,
            isolation=False,
            bwrap_path=bwrap_real,
            error=f"bwrap --version failed: {out}",
        )

    runtime_binds: list[str] = []
    for path in ("/usr", "/lib", "/lib64", "/bin", "/sbin"):
        if Path(path).exists():
            runtime_binds.extend(["--ro-bind", path, path])

    with tempfile.TemporaryDirectory(prefix="scout-probe-hidden-") as hidden_tmp:
        hidden = Path(hidden_tmp) / "hidden.txt"
        hidden.write_text("hidden", encoding="utf-8")

        with tempfile.TemporaryDirectory(prefix="scout-probe-bind-") as tmp:
            tmp_path = Path(tmp)

            oneshot_cmd = [
                bwrap_real,
                "--unshare-all",
                "--die-with-parent",
                "--new-session",
                "--proc", "/proc",
                "--dev", "/dev",
                "--tmpfs", "/tmp",
                *runtime_binds,
                "--ro-bind", str(tmp_path), str(tmp_path),
                "--chdir", str(tmp_path),
                "--",
                "/bin/sh", "-c",
                f"test ! -r {hidden} && echo probe-ok",
            ]
            oneshot_ok, oneshot_out = _run_probe(oneshot_cmd)

            repl_cmd = [
                bwrap_real,
                "--unshare-all",
                "--die-with-parent",
                "--new-session",
                "--proc", "/proc",
                "--dev", "/dev",
                "--tmpfs", "/tmp",
                *runtime_binds,
                "--bind", str(tmp_path), str(tmp_path),
                "--chdir", str(tmp_path),
                "--",
                "/bin/sh", "-c",
                "read line; test \"$line\" = ping && echo pong",
            ]
            persistent_ok = False
            try:
                proc = subprocess.Popen(
                    repl_cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                assert proc.stdin and proc.stdout
                proc.stdin.write("ping\n")
                proc.stdin.flush()
                line = proc.stdout.readline().strip()
                persistent_ok = line == "pong"
                proc.stdin.close()
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except OSError as exc:
                warnings.append(f"persistent probe spawn failed: {exc}")

            isolation = oneshot_ok and persistent_ok
            error = None
            if not oneshot_ok:
                error = f"oneshot isolation probe failed: {oneshot_out}"
            elif not persistent_ok:
                error = "persistent isolation probe failed"

            return SandboxProbeResult(
                available=isolation,
                isolation=isolation,
                bwrap_path=bwrap_real,
                persistent_python=persistent_ok,
                oneshot=oneshot_ok,
                error=error,
                warnings=warnings,
            )
