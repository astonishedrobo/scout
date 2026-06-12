"""Structured execution error categories."""

from __future__ import annotations

from enum import Enum


class ExecutionErrorCategory(str, Enum):
    COMMAND_FAILED = "command_failed"
    TIMED_OUT = "timed_out"
    RESOURCE_LIMIT_EXCEEDED = "resource_limit_exceeded"
    SANDBOX_UNAVAILABLE = "sandbox_unavailable"
    CAPABILITY_DENIED = "capability_denied"
    CAPABILITY_APPROVAL_REQUIRED = "capability_approval_required"
    RUNTIME_UNAVAILABLE = "runtime_unavailable"
    WORKER_CRASHED = "worker_crashed"
    ARTIFACT_PROMOTION_CONFLICT = "artifact_promotion_conflict"
