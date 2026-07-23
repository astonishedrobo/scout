"""Named permission profiles for Scout agents."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PermissionProfileName = Literal["analyst", "contributor", "admin"]

VALID_PROFILES: frozenset[str] = frozenset({"analyst", "contributor", "admin"})
DEFAULT_PROFILE: PermissionProfileName = "contributor"


@dataclass(frozen=True)
class ProfileConfig:
    name: PermissionProfileName
    disable_write_tools: bool
    allow_shared_write: bool
    shell_enabled: bool
    personal_write: bool
    allowed_tools: frozenset[str]
    can_request_permissions: bool = True


_PROFILES: dict[PermissionProfileName, ProfileConfig] = {
    "analyst": ProfileConfig(
        name="analyst",
        disable_write_tools=True,
        allow_shared_write=False,
        shell_enabled=False,
        personal_write=False,
        can_request_permissions=False,
        allowed_tools=frozenset({
            "read_file", "list_files", "search_workspace", "filter_table",
            "present_files",
            "think", "ask_user_choice",
            "memory_search", "memory_read", "memory_list",
            "skill_list", "skill_read",
            # Read-only parents may still spawn explore/plan sub-agents.
            "spawn_subagent", "list_subagents", "get_subagent_result",
            "stop_subagent", "send_subagent_message",
        }),
    ),
    "contributor": ProfileConfig(
        name="contributor",
        disable_write_tools=False,
        allow_shared_write=False,
        shell_enabled=True,
        personal_write=True,
        can_request_permissions=True,
        allowed_tools=frozenset({
            "read_file", "list_files", "search_workspace", "filter_table",
            "present_files",
            "exec_command", "write_stdin", "run_node",
            "write_file", "write_binary_artifact", "apply_patch",
            "memory_search", "memory_read", "memory_list", "memory_add_note",
            "skill_list", "skill_read", "request_permissions",
            "think", "ask_user_choice",
            "spawn_subagent", "list_subagents", "get_subagent_result",
            "stop_subagent", "send_subagent_message",
        }),
    ),
    "admin": ProfileConfig(
        name="admin",
        disable_write_tools=False,
        allow_shared_write=True,
        shell_enabled=True,
        personal_write=True,
        can_request_permissions=True,
        allowed_tools=frozenset({
            "read_file", "list_files", "search_workspace", "filter_table",
            "present_files",
            "exec_command", "write_stdin", "run_node",
            "write_file", "write_binary_artifact", "apply_patch",
            "memory_search", "memory_read", "memory_list", "memory_add_note",
            "skill_list", "skill_read", "request_permissions",
            "think", "ask_user_choice",
            "spawn_subagent", "list_subagents", "get_subagent_result",
            "stop_subagent", "send_subagent_message",
        }),
    ),
}


def normalize_profile(name: str | None) -> PermissionProfileName:
    if name and name in VALID_PROFILES:
        return name  # type: ignore[return-value]
    return DEFAULT_PROFILE


def resolve_profile(name: str | None) -> ProfileConfig:
    return _PROFILES[normalize_profile(name)]


def profile_from_user(
    *,
    permission_profile: str | None = None,
    is_admin: bool = False,
) -> ProfileConfig:
    """Resolve profile from DB fields; is_admin legacy maps to admin when unset."""
    if permission_profile and permission_profile in VALID_PROFILES:
        return resolve_profile(permission_profile)
    if is_admin:
        return resolve_profile("admin")
    return resolve_profile(DEFAULT_PROFILE)
