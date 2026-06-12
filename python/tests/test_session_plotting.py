from pathlib import Path

import pytest

from scout.agent.session import PersistentPythonSession

AGENTS_PYTHON = Path.home() / ".miniconda3/envs/agents/bin/python"
pytestmark = pytest.mark.skipif(not AGENTS_PYTHON.exists(), reason="agents environment unavailable")


def test_matplotlib_can_read_installed_styles_and_write_private_cache(tmp_path: Path):
    session = PersistentPythonSession(
        cwd=tmp_path,
        python_path=str(AGENTS_PYTHON),
        allowed_paths=[str(tmp_path), str(tmp_path / ".scout-cache")],
        cache_dir=tmp_path / ".scout-cache",
    )
    try:
        output, success = session.run(
            "import matplotlib.pyplot as plt\n"
            "plt.figure()\n"
            "plt.hist([1, 2, 2, 3])\n"
            "print('plot-ok')\n"
        )
        assert success, output
        assert "plot-ok" in output
        assert (tmp_path / ".scout-cache" / "matplotlib").is_dir()
    finally:
        session.close()


def test_python_can_read_shared_but_only_write_personal(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    shared = tmp_path / "shared"
    personal.mkdir(parents=True)
    shared.mkdir()
    (shared / "context.txt").write_text("team context")

    session = PersistentPythonSession(
        cwd=personal,
        python_path=str(AGENTS_PYTHON),
        allowed_paths=[str(personal), str(shared)],
    )
    try:
        output, success = session.run(
            f"print(open({str(shared / 'context.txt')!r}).read())\n"
            "open('result.txt', 'w').write('personal result')\n"
        )
        assert success, output
        assert "team context" in output
        assert (personal / "result.txt").read_text() == "personal result"

        output, success = session.run(
            f"open({str(shared / 'forbidden.txt')!r}, 'w').write('no')"
        )
        assert not success
        assert "Access denied" in output
        assert not (shared / "forbidden.txt").exists()
    finally:
        session.close()


def test_path_guard_is_reinstalled_after_restart(tmp_path: Path):
    personal = tmp_path / "users" / "1"
    outside = tmp_path / "outside.txt"
    personal.mkdir(parents=True)
    outside.write_text("secret")

    session = PersistentPythonSession(
        cwd=personal,
        python_path=str(AGENTS_PYTHON),
        allowed_paths=[str(personal)],
    )
    try:
        session._restart()
        output, success = session.run(f"open({str(outside)!r}).read()")
        assert not success
        assert "Access denied" in output
    finally:
        session.close()
