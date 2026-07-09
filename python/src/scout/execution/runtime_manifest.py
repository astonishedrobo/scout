"""Single source of truth for sandbox runtime capabilities shown to the agent."""

from __future__ import annotations

# Packages preinstalled in the Scout sandbox image for offline data work.
# Keep this list in sync with python/requirements.txt data-stack deps.
PREINSTALLED_PYTHON_PACKAGES: tuple[str, ...] = (
    "numpy",
    "pandas",
    "matplotlib",
    "pillow",
    "openpyxl",
    "pymupdf",
    "pdfplumber",
)


def preinstalled_packages_text() -> str:
    return ", ".join(PREINSTALLED_PYTHON_PACKAGES)


def sandbox_runtime_prompt_section() -> str:
    pkgs = preinstalled_packages_text()
    return f"""\
## Sandbox Runtime

- Working directory is `/workspace`. Shared data is under `/shared`.
- **Preinstalled Python packages (offline, do not install or reinstall):** {pkgs}.
  Import these directly. Prefer `python script.py` for analysis and plotting.
- User-installed packages persist under `/workspace/.scout-cache/python-packages`
  via `PIP_TARGET`/`PYTHONPATH`. After a real `ModuleNotFoundError`, request
  network permission for PyPI, then install once with:
  `python -m pip install <package>`
  Do not use `pip install --user` or invent `./.local` targets.
- Network is denied by default. Call `request_permissions` only after a real
  blocked operation, with narrow domains (e.g. `pypi.org,files.pythonhosted.org`).
- Do not run `uv init` / create a project unless the user asked for a managed
  project. Prefer the preinstalled interpreter for ordinary data work.
- Writable places: `/workspace`, `/workspace/.scout-cache`, and `/tmp`.
  Do not write outside those roots.
"""
