"""Tests for shell network capability detection."""

from scout.execution.orchestrator import ExecutionOrchestrator


def test_needs_network_detects_bare_pip():
    assert ExecutionOrchestrator._needs_network("pip install matplotlib")


def test_needs_network_detects_uv_package_commands():
    assert ExecutionOrchestrator._needs_network("uv add pandas")
    assert ExecutionOrchestrator._needs_network("uv run --with openpyxl analyze.py")


def test_needs_network_detects_python_module_pip():
    assert ExecutionOrchestrator._needs_network("python -m pip install matplotlib")
    assert ExecutionOrchestrator._needs_network("python3.11 -m pip install requests")


def test_needs_network_ignores_local_python():
    assert not ExecutionOrchestrator._needs_network("python -c 'print(1)'")
    assert not ExecutionOrchestrator._needs_network("ls -la")


def test_infer_domains_for_pip_commands():
    domains = ExecutionOrchestrator._infer_domains("python -m pip install matplotlib")
    assert "pypi.org" in domains
    assert "files.pythonhosted.org" in domains


def test_infer_domains_for_uv_commands():
    domains = ExecutionOrchestrator._infer_domains("uv add pandas")
    assert "pypi.org" in domains
    assert "files.pythonhosted.org" in domains


def test_infer_domains_for_npm_commands():
    domains = ExecutionOrchestrator._infer_domains("npm install lodash")
    assert domains == ["registry.npmjs.org"]
