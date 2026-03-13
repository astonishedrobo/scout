"""Persistent Python session running inside a conda environment.

Spawns ``_repl_server.py`` as a child process using the conda env's
Python binary directly (avoids ``conda run`` stdout buffering) and
communicates through stdin/stdout using sentinel delimiters.

The child process keeps a single Python namespace alive across all
``run()`` calls — imports, DataFrames, and variables persist just like
a Jupyter kernel.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

# Must match _repl_server.py
_CODE_END = "<<__END_OF_CODE__>>"
_OUTPUT_END = "<<__END_OF_OUTPUT__>>"

_REPL_SCRIPT = str(Path(__file__).with_name("_repl_server.py"))

# Maximum output characters returned to the LLM (avoid context blowup)
_MAX_OUTPUT_CHARS = 4_000


def _find_conda_python(conda_env: str) -> str:
    """Locate the Python binary inside a conda environment.

    Tries ``conda info --envs`` to find the env prefix, then falls back
    to well-known paths.  Raises ``FileNotFoundError`` if nothing works.
    """
    # Method 1: ask conda for the env prefix
    try:
        result = subprocess.run(
            ["conda", "info", "--envs"],
            capture_output=True, text=True, timeout=10,
        )
        for line in result.stdout.splitlines():
            parts = line.split()
            # Lines look like:  agents   /home/user/.miniconda3/envs/agents
            if parts and parts[0] == conda_env:
                prefix = Path(parts[-1])
                py = prefix / "bin" / "python"
                if py.exists():
                    return str(py)
    except Exception:
        pass

    # Method 2: common conda install locations
    for base in (
        Path.home() / ".miniconda3",
        Path.home() / "miniconda3",
        Path.home() / ".anaconda3",
        Path.home() / "anaconda3",
        Path("/opt/conda"),
    ):
        py = base / "envs" / conda_env / "bin" / "python"
        if py.exists():
            return str(py)

    # Method 3: fallback — just use whatever python is on PATH
    py_path = shutil.which("python")
    if py_path:
        logger.warning(
            "Could not find conda env '%s' — falling back to %s",
            conda_env, py_path,
        )
        return py_path

    raise FileNotFoundError(
        f"Cannot locate Python for conda env '{conda_env}'"
    )


class PersistentPythonSession:
    """Manage a long-lived Python subprocess.

    Parameters
    ----------
    conda_env : str
        Name of the conda environment to use (fallback when python_path is None).
    cwd : str | Path
        Working directory for the subprocess.
    timeout : int
        Default seconds before a code block is killed.
    python_path : str | None
        Absolute path to a Python binary (e.g. from a venv).
        When set, takes priority over conda_env.
    """

    def __init__(
        self,
        conda_env: str = "agents",
        cwd: str | Path = ".",
        timeout: int = 30,
        python_path: str | None = None,
    ) -> None:
        self._conda_env = conda_env
        if python_path and Path(python_path).exists():
            self._python = python_path
            logger.info("Using explicit Python path: %s", python_path)
        else:
            self._python = _find_conda_python(conda_env)
        self._cwd = str(Path(cwd).resolve())
        self._timeout = timeout
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._start()

    # ── lifecycle ────────────────────────────────────────────────────────

    def _start(self) -> None:
        """Spawn the REPL subprocess."""
        # Defense-in-depth: Filter out sensitive keys from the child process env
        env = {}
        for k, v in os.environ.items():
            k_upper = k.upper()
            if any(secret in k_upper for secret in ["API_KEY", "SECRET", "PASSWORD", "TOKEN"]):
                continue
            if k_upper.startswith("SCOUT_"):
                continue
            env[k] = v

        # Ensure UTF-8 output
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"

        self._proc = subprocess.Popen(
            [self._python, "-u", _REPL_SCRIPT],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,      # merge stderr into stdout
            cwd=self._cwd,
            env=env,
            text=True,
            bufsize=1,                      # line-buffered
        )
        logger.info(
            "Started persistent session (pid=%s, env=%s, cwd=%s)",
            self._proc.pid, self._conda_env, self._cwd,
        )

    def close(self) -> None:
        """Terminate the subprocess gracefully."""
        if self._proc and self._proc.poll() is None:
            self._proc.stdin.close()  # type: ignore[union-attr]
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            logger.info("Closed persistent session (pid=%s)", self._proc.pid)
        self._proc = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _restart(self) -> None:
        """Kill and re-spawn the subprocess (e.g. after a timeout)."""
        logger.warning("Restarting persistent session …")
        self.close()
        self._start()

    # ── code execution ──────────────────────────────────────────────────

    def run(self, code: str, timeout: int | None = None) -> tuple[str, bool]:
        """Execute *code* in the persistent session.

        Returns
        -------
        output : str
            Captured stdout/stderr (truncated to ``_MAX_OUTPUT_CHARS``).
        success : bool
            ``False`` if the code raised an exception or timed out.
        """
        timeout = timeout or self._timeout

        with self._lock:
            if not self.alive:
                self._restart()

            assert self._proc is not None  # for type-checker
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None

            # Send code block + sentinel
            try:
                self._proc.stdin.write(code)
                if not code.endswith("\n"):
                    self._proc.stdin.write("\n")
                self._proc.stdin.write(_CODE_END + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                self._restart()
                return "[Session crashed — restarted]", False

            # Read output until sentinel (with timeout via thread)
            output_lines: list[str] = []
            timed_out = False

            def _reader() -> None:
                nonlocal timed_out
                try:
                    for line in self._proc.stdout:  # type: ignore[union-attr]
                        stripped = line.rstrip("\n")
                        if stripped == _OUTPUT_END:
                            break
                        output_lines.append(line)
                except Exception:
                    pass

            reader_thread = threading.Thread(target=_reader, daemon=True)
            reader_thread.start()
            reader_thread.join(timeout=timeout)

            if reader_thread.is_alive():
                # Timed out — kill and restart
                timed_out = True
                self._restart()
                return (
                    f"[Execution timed out after {timeout}s — session restarted]",
                    False,
                )

            output = "".join(output_lines)

            # Truncate very large output
            if len(output) > _MAX_OUTPUT_CHARS:
                output = (
                    output[: _MAX_OUTPUT_CHARS // 2]
                    + f"\n\n… [output truncated: {len(output)} chars total] …\n\n"
                    + output[-_MAX_OUTPUT_CHARS // 2 :]
                )

            # Heuristic: if the output contains "Traceback", treat as failure
            success = "Traceback (most recent call last)" not in output
            return output.rstrip(), success

    # ── context manager ─────────────────────────────────────────────────

    def __enter__(self) -> "PersistentPythonSession":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
