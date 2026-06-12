"""Capability grant storage — scoped to user/session with expiry."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal


GrantScope = Literal["once", "session"]


@dataclass
class CapabilityGrant:
    grant_id: str
    user_id: str
    session_id: str
    capability: str
    scope: dict
    grant_scope: GrantScope
    created_at: float
    expires_at: float
    used: bool = False


@dataclass
class CapabilityGrantStore:
    """In-memory capability grants (server-side only)."""

    _grants: dict[str, CapabilityGrant] = field(default_factory=dict)
    default_ttl_seconds: float = 3600.0

    def add(
        self,
        grant_id: str,
        user_id: str,
        session_id: str,
        capability: str,
        scope: dict,
        grant_scope: GrantScope = "session",
        ttl_seconds: float | None = None,
    ) -> CapabilityGrant:
        now = time.time()
        ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl_seconds
        grant = CapabilityGrant(
            grant_id=grant_id,
            user_id=user_id,
            session_id=session_id,
            capability=capability,
            scope=scope,
            grant_scope=grant_scope,
            created_at=now,
            expires_at=now + ttl,
        )
        self._grants[grant_id] = grant
        return grant

    def _purge_expired(self) -> None:
        now = time.time()
        expired = [gid for gid, g in self._grants.items() if g.expires_at < now]
        for gid in expired:
            del self._grants[gid]

    def get_active_grants(
        self,
        user_id: str,
        session_id: str,
        capability: str | None = None,
    ) -> list[CapabilityGrant]:
        self._purge_expired()
        result = []
        for g in self._grants.values():
            if g.user_id != user_id:
                continue
            if g.grant_scope == "session" and g.session_id != session_id:
                continue
            if g.grant_scope == "once" and g.used:
                continue
            if capability and g.capability != capability:
                continue
            result.append(g)
        return result

    def consume_once(self, grant_id: str) -> None:
        g = self._grants.get(grant_id)
        if g and g.grant_scope == "once":
            g.used = True

    def network_domains_for(self, user_id: str, session_id: str) -> tuple[str, ...]:
        domains: set[str] = set()
        for g in self.get_active_grants(user_id, session_id):
            if g.capability == "network_domain":
                for d in g.scope.get("domains", []):
                    domains.add(str(d))
        return tuple(sorted(domains))

    def clear_session(self, session_id: str) -> None:
        to_remove = [
            gid for gid, g in self._grants.items()
            if g.session_id == session_id and g.grant_scope == "session"
        ]
        for gid in to_remove:
            del self._grants[gid]

    def export_session(self, user_id: str, session_id: str) -> list[dict]:
        return [
            {
                "grant_id": g.grant_id,
                "capability": g.capability,
                "scope": g.scope,
                "grant_scope": g.grant_scope,
            }
            for g in self.get_active_grants(user_id, session_id)
        ]

    def import_session(
        self,
        user_id: str,
        session_id: str,
        grants: list[dict],
    ) -> None:
        import uuid
        for g in grants:
            self.add(
                grant_id=g.get("grant_id") or str(uuid.uuid4()),
                user_id=user_id,
                session_id=session_id,
                capability=g["capability"],
                scope=g.get("scope", {}),
                grant_scope=g.get("grant_scope", "session"),
            )
