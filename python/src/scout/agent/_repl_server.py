"""Persistent Python REPL that runs inside a conda subprocess.

This script is **not** imported by the host process.  It is launched as a
child process (``conda run -n <env> python _repl_server.py``) and
communicates via stdin/stdout using sentinel delimiters.

Protocol
--------
1. Host sends lines of Python code, terminated by ``CODE_END``.
2. This process ``exec``-s the code in a shared ``namespace`` dict.
3. stdout (including tracebacks) is collected and printed, followed by
   ``OUTPUT_END`` on its own line.
4. The namespace persists across calls — imports, DataFrames, variables
   are available in subsequent code blocks.
"""

from __future__ import annotations

import io
import os
import sys
import traceback

# ── Sentinels (must match session.py) ────────────────────────────────────────
CODE_END = "<<__END_OF_CODE__>>"
OUTPUT_END = "<<__END_OF_OUTPUT__>>"

# ── Force non-interactive matplotlib backend ─────────────────────────────────
# Must happen before any user code can `import matplotlib.pyplot`.
os.environ["MPLBACKEND"] = "Agg"
try:
    import matplotlib
    matplotlib.use("Agg")
except ImportError:
    pass  # matplotlib not installed — no problem

# ── Persistent namespace shared across all executions ────────────────────────
namespace: dict = {"__builtins__": __builtins__}


def _run_code(code: str) -> str:
    """Execute *code* in the persistent namespace and return captured output."""
    buf = io.StringIO()
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = buf
    try:
        # Compile first — choose eval vs exec mode *before* executing.
        # This avoids running exec() inside an `except SyntaxError` handler,
        # which would cause Python's implicit exception chaining to attach a
        # misleading SyntaxError traceback to any runtime error.
        try:
            compiled = compile(code, "<agent>", "eval")
        except SyntaxError:
            compiled = compile(code, "<agent>", "exec")
            is_eval = False
        else:
            is_eval = True

        if is_eval:
            result = eval(compiled, namespace)
            if result is not None:
                print(repr(result))
        else:
            exec(compiled, namespace)
    except Exception:
        traceback.print_exc(file=buf)
    finally:
        sys.stdout, sys.stderr = old_stdout, old_stderr
    return buf.getvalue()


def main() -> None:
    """Read-eval-print loop driven by stdin sentinels."""
    # Unbuffered-ish: we flush after every output block.
    while True:
        lines: list[str] = []
        for raw_line in sys.stdin:
            if raw_line.rstrip("\n") == CODE_END:
                break
            lines.append(raw_line)
        else:
            # stdin closed → exit cleanly
            break

        code = "".join(lines)
        if not code.strip():
            # Empty block — still send the sentinel so the host doesn't hang
            print(OUTPUT_END, flush=True)
            continue

        output = _run_code(code)
        # Send output followed by sentinel
        sys.stdout.write(output)
        if output and not output.endswith("\n"):
            sys.stdout.write("\n")
        print(OUTPUT_END, flush=True)


if __name__ == "__main__":
    main()
