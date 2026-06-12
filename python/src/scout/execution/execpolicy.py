"""Persistent shell command allow rules (execpolicy)."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

_XDG_CONFIG = Path.home() / ".config" / "scout"
_MAX_RULES = 50
_DENY_PREFIXES = ("rm ", "rm -", "sudo ", "chmod ", "chown ")


class PolicyMatch(Enum):
    ALLOW = "allow"
    PROMPT = "prompt"
    DENY = "deny"


@dataclass
class ExecPolicyRule:
    prefix: str
    scope: Literal["session", "always"] = "always"
    domains: tuple[str, ...] = ()


def execpolicy_path(personal_dir: Path | str | None = None, server_mode: bool = False) -> Path:
    if server_mode and personal_dir:
        return Path(personal_dir) / ".scout" / "execpolicy.toml"
    return _XDG_CONFIG / "execpolicy.toml"


def layered_execpolicy_paths(
    *,
    personal_dir: Path | str | None = None,
    project_dir: Path | str | None = None,
    server_mode: bool = False,
) -> list[Path]:
    """User → project → personal (server) merge order."""
    paths: list[Path] = []
    user_path = _XDG_CONFIG / "execpolicy.toml"
    if user_path.exists():
        paths.append(user_path)
    if project_dir:
        proj = Path(project_dir) / ".scout" / "execpolicy.toml"
        if proj.exists():
            paths.append(proj)
    personal = execpolicy_path(personal_dir, server_mode)
    if personal.exists() and personal not in paths:
        paths.append(personal)
    return paths


def _parse_toml_simple(text: str) -> list[ExecPolicyRule]:
    rules: list[ExecPolicyRule] = []
    current: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line == "[[allow]]":
            if current.get("prefix"):
                rules.append(_rule_from_dict(current))
            current = {}
        elif line.startswith("prefix"):
            current["prefix"] = _unquote(line.split("=", 1)[1].strip())
        elif line.startswith("scope"):
            current["scope"] = _unquote(line.split("=", 1)[1].strip())
        elif line.startswith("domains"):
            raw = line.split("=", 1)[1].strip()
            domains = re.findall(r'"([^"]+)"', raw)
            current["domains"] = ",".join(domains)
    if current.get("prefix"):
        rules.append(_rule_from_dict(current))
    return rules


def _unquote(s: str) -> str:
    s = s.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    return s


def _rule_from_dict(d: dict[str, str]) -> ExecPolicyRule:
    domains = tuple(d.get("domains", "").split(",")) if d.get("domains") else ()
    scope = d.get("scope", "always")
    if scope not in ("session", "always"):
        scope = "always"
    return ExecPolicyRule(prefix=d["prefix"], scope=scope, domains=domains)  # type: ignore[arg-type]


def _serialize_rules(rules: list[ExecPolicyRule]) -> str:
    lines = ["# Scout execpolicy — allowed command prefixes\n"]
    for r in rules:
        lines.append("[[allow]]")
        lines.append(f'prefix = "{r.prefix}"')
        lines.append(f'scope = "{r.scope}"')
        if r.domains:
            dom = ", ".join(f'"{d}"' for d in r.domains)
            lines.append(f"domains = [{dom}]")
        lines.append("")
    return "\n".join(lines)


def load_rules(
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
    *,
    project_dir: Path | str | None = None,
) -> list[ExecPolicyRule]:
    paths = layered_execpolicy_paths(
        personal_dir=personal_dir,
        project_dir=project_dir,
        server_mode=server_mode,
    )
    if not paths:
        legacy = execpolicy_path(personal_dir, server_mode)
        if legacy.exists():
            paths = [legacy]
    merged: dict[str, ExecPolicyRule] = {}
    for path in paths:
        try:
            for rule in _parse_toml_simple(path.read_text(encoding="utf-8")):
                merged[rule.prefix] = rule
        except OSError as exc:
            logger.warning("Could not read execpolicy %s: %s", path, exc)
    return list(merged.values())


def save_rules(
    rules: list[ExecPolicyRule],
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> None:
    path = execpolicy_path(personal_dir, server_mode)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_serialize_rules(rules[:_MAX_RULES]), encoding="utf-8")


def validate_prefix(prefix: str) -> str | None:
    """Return error message if prefix is invalid, else None."""
    if not prefix or not prefix.strip():
        return "Empty prefix"
    if "\n" in prefix or "\r" in prefix:
        return "Multi-line prefixes not allowed"
    p = prefix.strip()
    for deny in _DENY_PREFIXES:
        if p.startswith(deny) or p == deny.strip():
            return f"Prefix '{deny}' is not allowed"
    if p.startswith("curl ") and "://" not in p:
        return "curl requires explicit domain scope"
    return None


def add_rule(
    prefix: str,
    *,
    scope: Literal["session", "always"] = "always",
    domains: tuple[str, ...] = (),
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
) -> str | None:
    err = validate_prefix(prefix)
    if err:
        return err
    rules = load_rules(personal_dir, server_mode)
    if any(r.prefix == prefix for r in rules):
        return None
    if len(rules) >= _MAX_RULES:
        return "Maximum execpolicy rules reached"
    rules.append(ExecPolicyRule(prefix=prefix, scope=scope, domains=domains))
    save_rules(rules, personal_dir, server_mode)
    return None


def match_policy(
    command: str,
    *,
    personal_dir: Path | str | None = None,
    server_mode: bool = False,
    project_dir: Path | str | None = None,
    session_rules: list[str] | None = None,
) -> PolicyMatch:
    cmd = command.strip()
    if not cmd:
        return PolicyMatch.DENY

    prefixes: list[str] = list(session_rules or [])
    for r in load_rules(personal_dir, server_mode, project_dir=project_dir):
        if r.scope == "always":
            prefixes.append(r.prefix)

    for prefix in prefixes:
        if cmd.startswith(prefix) or cmd == prefix.strip():
            return PolicyMatch.ALLOW

    for deny in _DENY_PREFIXES:
        if cmd.startswith(deny):
            return PolicyMatch.DENY

    return PolicyMatch.PROMPT
