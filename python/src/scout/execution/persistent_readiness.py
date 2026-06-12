"""Worker readiness probe for persistent Python sessions."""

from __future__ import annotations

from typing import Protocol


class _ReplSession(Protocol):
    def run(self, code: str, timeout: int | None = None) -> tuple[str, bool]: ...


def probe_python_readiness(session: _ReplSession) -> tuple[bool, str | None]:
    """Verify cache dirs are writable and common viz deps import cleanly."""
    checks = [
        "import os\n"
        "for p in [os.environ.get('MPLCONFIGDIR'), os.environ.get('XDG_CACHE_HOME'), os.environ.get('NUMBA_CACHE_DIR')]:\n"
        "    assert p and os.path.isdir(p), f'cache missing: {p}'\n"
        "    test = os.path.join(p, '.write-test')\n"
        "    open(test, 'w').write('ok')\n"
        "    os.remove(test)\n"
        "print('cache-ok')\n",
        "try:\n"
        "    import matplotlib\n"
        "    matplotlib.use('Agg')\n"
        "    import matplotlib.pyplot as plt\n"
        "    print('matplotlib-ok')\n"
        "except ImportError as e:\n"
        "    print(f'matplotlib-unavailable: {e}')\n",
    ]
    for code in checks:
        output, success = session.run(code, timeout=30)
        if not success and "matplotlib-unavailable" not in output:
            return False, output.strip() or "Readiness probe failed"
        if "cache-ok" not in output and "matplotlib" not in output:
            if not success:
                return False, output.strip()
    return True, None
