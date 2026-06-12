"""Execution sandbox data models."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Mapping


@dataclass(frozen=True)
class NetworkPolicy:
    mode: Literal["deny", "allow_domains"] = "deny"
    domains: tuple[str, ...] = ()


@dataclass(frozen=True)
class ExecutionPolicy:
    read_roots: tuple[Path, ...]
    write_roots: tuple[Path, ...]
    denied_roots: tuple[Path, ...]
    network: NetworkPolicy
    timeout_seconds: int
    max_output_bytes: int
    max_memory_bytes: int | None = None
    max_processes: int | None = None
    cpu_seconds: int | None = None


@dataclass(frozen=True)
class CapabilityRequest:
    capability: Literal[
        "network_domain",
        "shared_write",
        "preview_port",
        "gpu",
    ]
    reason: str
    scope: dict
    command_summary: str


@dataclass(frozen=True)
class ExecutionRequest:
    execution_id: str
    user_id: str
    session_id: str
    runtime: Literal["python", "shell", "node"]
    command: tuple[str, ...] | None
    code: str | None
    cwd: Path
    policy: ExecutionPolicy
    environment: Mapping[str, str]
    persistent: bool = False
    staging_dir: Path | None = None
    scratch_dir: Path | None = None
    sandbox_python: str = ""


@dataclass
class ExecutionFileChange:
    path: str
    status: str
    old_hash: str | None = None
    new_hash: str | None = None


@dataclass
class ExecutionResult:
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool = False
    error_category: str | None = None
    denied_capability: CapabilityRequest | None = None
    changed_files: list[ExecutionFileChange] = field(default_factory=list)
    artifacts: list[dict] = field(default_factory=list)
    promotion_diffs: list = field(default_factory=list)
    persistent: bool = False


@dataclass
class ExecutionBackendHealth:
    available: bool
    backend: str
    isolation: bool
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
    persistent_python: bool = False
    oneshot: bool = False
    worker_reachable: bool = False
    isolation_tier: str | None = None
