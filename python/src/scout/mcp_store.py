"""Durable MCP integration registry and per-user preferences.

The registry is deliberately separate from the deployment YAML: deployment
configuration can bootstrap integrations, while this store owns live admin and
user changes and survives container recreation through ``SCOUT_HOME``.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from .server.auth import SCOUT_HOME
from .secrets import load_secret


def _db_path() -> Path:
    return SCOUT_HOME / "mcp.sqlite"


def _fernet() -> Fernet:
    secret = load_secret("SCOUT_SECRET_KEY", "fallback_secret_key_for_dev_only_please_change")
    key = hashlib.sha256(secret.encode("utf-8")).digest()
    import base64
    return Fernet(base64.urlsafe_b64encode(key))


class McpStore:
    """Small SQLite store for admin-managed MCP definitions."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else _db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @staticmethod
    def _uid(user_id: int | str) -> int:
        # Single-user deployments use the synthetic ``default`` identity.
        # Keep the SQLite schema integer-based while giving that identity a
        # stable row key.
        return 0 if str(user_id) == "default" else int(user_id)

    def _init(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS mcp_servers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    transport TEXT NOT NULL CHECK (transport IN ('streamable_http','container_stdio')),
                    url TEXT,
                    image TEXT,
                    command_json TEXT NOT NULL DEFAULT '[]',
                    args_json TEXT NOT NULL DEFAULT '[]',
                    availability TEXT NOT NULL DEFAULT 'everyone',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    auth_mode TEXT NOT NULL DEFAULT 'none',
                    shared_credential BLOB,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(name)
                );
                CREATE TABLE IF NOT EXISTS mcp_server_users (
                    server_id TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    credential BLOB,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY(server_id, user_id),
                    FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS mcp_tools (
                    server_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    title TEXT,
                    description TEXT NOT NULL DEFAULT '',
                    input_schema_json TEXT NOT NULL,
                    output_schema_json TEXT,
                    read_only INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY(server_id, name),
                    FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS mcp_bootstrap_tombstones (
                    server_id TEXT PRIMARY KEY,
                    deleted_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mcp_bootstrap_state (
                    server_id TEXT PRIMARY KEY,
                    definition_hash TEXT NOT NULL,
                    imported_at REAL NOT NULL
                );
                """
            )

    @staticmethod
    def _enc(value: str | None) -> bytes | None:
        return _fernet().encrypt(value.encode("utf-8")) if value else None

    @staticmethod
    def _dec(value: bytes | None) -> str | None:
        if not value:
            return None
        try:
            return _fernet().decrypt(value).decode("utf-8")
        except InvalidToken:
            return None

    @staticmethod
    def _server(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "name": row["name"], "transport": row["transport"],
            "url": row["url"], "image": row["image"],
            "command": json.loads(row["command_json"] or "[]"),
            "args": json.loads(row["args_json"] or "[]"),
            "availability": row["availability"], "enabled": bool(row["enabled"]),
            "auth_mode": row["auth_mode"], "created_at": row["created_at"],
            "updated_at": row["updated_at"], "deleted": bool(row["deleted"]),
        }

    def list_servers(self, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        with self._connect() as conn:
            query = "SELECT * FROM mcp_servers"
            if not include_deleted:
                query += " WHERE deleted=0"
            rows = conn.execute(query + " ORDER BY name").fetchall()
            return [self._server(row) for row in rows]

    def revision(self) -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT COALESCE(MAX(updated_at),0) FROM mcp_servers").fetchone()
            user_row = conn.execute("SELECT COALESCE(MAX(updated_at),0) FROM mcp_server_users").fetchone()
            tool_row = conn.execute("SELECT COALESCE(MAX(updated_at),0) FROM mcp_tools").fetchone()
            return hash((row[0], user_row[0], tool_row[0]))

    def get_server(self, server_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone()
            return self._server(row) if row else None

    def upsert_server(self, data: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        server_id = str(data["id"])
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO mcp_servers
                (id,name,transport,url,image,command_json,args_json,availability,enabled,auth_mode,created_at,updated_at,deleted)
                VALUES (?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM mcp_servers WHERE id=?),?),?,0)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,url=excluded.url,
                image=excluded.image,command_json=excluded.command_json,args_json=excluded.args_json,
                availability=excluded.availability,enabled=excluded.enabled,auth_mode=excluded.auth_mode,
                updated_at=excluded.updated_at,deleted=0""",
                (server_id, str(data["name"]), str(data["transport"]), data.get("url"), data.get("image"),
                 json.dumps(data.get("command") or []), json.dumps(data.get("args") or []),
                 data.get("availability", "everyone"), int(bool(data.get("enabled", True))),
                 data.get("auth_mode", "none"), server_id, now, now),
            )
        return self.get_server(server_id) or {}

    def delete_server(self, server_id: str) -> bool:
        with self._connect() as conn:
            changed = conn.execute("UPDATE mcp_servers SET deleted=1,enabled=0,updated_at=? WHERE id=?", (time.time(), server_id)).rowcount
            conn.execute("INSERT OR REPLACE INTO mcp_bootstrap_tombstones(server_id,deleted_at) VALUES(?,?)", (server_id, time.time()))
            return bool(changed)

    def set_server_enabled(self, server_id: str, enabled: bool) -> bool:
        with self._connect() as conn:
            return bool(conn.execute("UPDATE mcp_servers SET enabled=?,updated_at=? WHERE id=?", (int(enabled), time.time(), server_id)).rowcount)

    def set_user(self, server_id: str, user_id: int | str, *, enabled: bool | None = None, credential: str | None = None) -> None:
        uid = self._uid(user_id)
        with self._connect() as conn:
            current = conn.execute("SELECT enabled,credential FROM mcp_server_users WHERE server_id=? AND user_id=?", (server_id, uid)).fetchone()
            next_enabled = int(enabled if enabled is not None else bool(current and current[0]))
            next_credential = self._enc(credential) if credential is not None else (current[1] if current else None)
            conn.execute("""INSERT INTO mcp_server_users(server_id,user_id,enabled,credential,updated_at)
                VALUES(?,?,?,?,?) ON CONFLICT(server_id,user_id) DO UPDATE SET enabled=excluded.enabled,credential=excluded.credential,updated_at=excluded.updated_at""",
                (server_id, uid, next_enabled, next_credential, time.time()))

    def set_user_assignment(self, server_id: str, user_id: int | str, assigned: bool) -> None:
        """Grant or revoke availability for a selected-users integration."""
        uid = self._uid(user_id)
        with self._connect() as conn:
            if not assigned:
                conn.execute("DELETE FROM mcp_server_users WHERE server_id=? AND user_id=?", (server_id, uid))
                return
            conn.execute(
                """INSERT INTO mcp_server_users(server_id,user_id,enabled,credential,updated_at)
                VALUES(?,?,0,NULL,?) ON CONFLICT(server_id,user_id) DO UPDATE SET updated_at=excluded.updated_at""",
                (server_id, uid, time.time()),
            )

    def assigned_users(self, server_id: str) -> list[int]:
        with self._connect() as conn:
            return [
                int(row[0])
                for row in conn.execute(
                    "SELECT user_id FROM mcp_server_users WHERE server_id=? ORDER BY user_id", (server_id,)
                ).fetchall()
            ]

    def user_config(self, server_id: str, user_id: int | str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT enabled,credential FROM mcp_server_users WHERE server_id=? AND user_id=?", (server_id, self._uid(user_id))).fetchone()
            return {"enabled": bool(row[0]) if row else False, "credential": self._dec(row[1]) if row else None}

    def server_credential(self, server_id: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT shared_credential FROM mcp_servers WHERE id=?", (server_id,)).fetchone()
            return self._dec(row[0]) if row else None

    def has_shared_credential(self, server_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute("SELECT shared_credential FROM mcp_servers WHERE id=?", (server_id,)).fetchone()
            return bool(row and row[0])

    def set_shared_credential(self, server_id: str, credential: str | None) -> None:
        with self._connect() as conn:
            conn.execute("UPDATE mcp_servers SET shared_credential=?,updated_at=? WHERE id=?", (self._enc(credential), time.time(), server_id))

    def allowed_for_user(self, server_id: str, user_id: int | str) -> bool:
        server = self.get_server(server_id)
        if not server or not server["enabled"] or server["deleted"]:
            return False
        if server["availability"] == "everyone":
            return True
        with self._connect() as conn:
            return conn.execute("SELECT 1 FROM mcp_server_users WHERE server_id=? AND user_id=?", (server_id, self._uid(user_id))).fetchone() is not None

    def list_for_user(self, user_id: int | str) -> list[dict[str, Any]]:
        result = []
        for server in self.list_servers():
            if server["availability"] == "everyone" or self.allowed_for_user(server["id"], user_id):
                cfg = self.user_config(server["id"], user_id)
                server["user_enabled"] = cfg["enabled"]
                server["has_credential"] = bool(cfg["credential"])
                result.append(server)
        return result

    def upsert_tools(self, server_id: str, tools: list[dict[str, Any]]) -> None:
        with self._connect() as conn:
            for tool in tools:
                conn.execute("""INSERT INTO mcp_tools(server_id,name,title,description,input_schema_json,output_schema_json,read_only,enabled,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(server_id,name) DO UPDATE SET title=excluded.title,description=excluded.description,
                    input_schema_json=excluded.input_schema_json,output_schema_json=excluded.output_schema_json,updated_at=excluded.updated_at""",
                    (server_id, tool["name"], tool.get("title"), tool.get("description", ""), json.dumps(tool.get("inputSchema") or {"type": "object"}),
                     json.dumps(tool.get("outputSchema")) if tool.get("outputSchema") else None, int(bool(tool.get("read_only", False))), 1, time.time()))

    def list_tools(self, server_id: str, *, include_disabled: bool = False) -> list[dict[str, Any]]:
        with self._connect() as conn:
            query = "SELECT * FROM mcp_tools WHERE server_id=?"
            if not include_disabled:
                query += " AND enabled=1"
            rows = conn.execute(query + " ORDER BY name", (server_id,)).fetchall()
            return [{"server_id": row["server_id"], "name": row["name"], "title": row["title"], "description": row["description"],
                     "inputSchema": json.loads(row["input_schema_json"]), "outputSchema": json.loads(row["output_schema_json"]) if row["output_schema_json"] else None,
                     "read_only": bool(row["read_only"]), "enabled": bool(row["enabled"])} for row in rows]

    def set_tool_policy(self, server_id: str, name: str, *, enabled: bool | None = None, read_only: bool | None = None) -> bool:
        fields, values = [], []
        if enabled is not None: fields += ["enabled=?"]; values.append(int(enabled))
        if read_only is not None: fields += ["read_only=?"]; values.append(int(read_only))
        if not fields: return False
        values += [server_id, name]
        with self._connect() as conn:
            return bool(conn.execute(f"UPDATE mcp_tools SET {','.join(fields)},updated_at=? WHERE server_id=? AND name=?", [*values[:-2], time.time(), *values[-2:]]).rowcount)

    def import_bootstrap(self, definitions: list[dict[str, Any]]) -> int:
        """Reconcile changed deployment definitions without clobbering live edits."""
        imported = 0
        present: set[str] = set()
        for definition in definitions:
            server_id = str(definition.get("id") or "")
            if not server_id:
                continue
            present.add(server_id)
            definition_hash = hashlib.sha256(
                json.dumps(definition, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            with self._connect() as conn:
                tombstoned = conn.execute("SELECT 1 FROM mcp_bootstrap_tombstones WHERE server_id=?", (server_id,)).fetchone()
                previous = conn.execute(
                    "SELECT definition_hash FROM mcp_bootstrap_state WHERE server_id=?", (server_id,)
                ).fetchone()
            if tombstoned:
                continue
            if not previous or previous[0] != definition_hash:
                self.upsert_server(definition)
                with self._connect() as conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO mcp_bootstrap_state(server_id,definition_hash,imported_at) VALUES(?,?,?)",
                        (server_id, definition_hash, time.time()),
                    )
                imported += 1

        # Definitions removed through `npm run deploy` are removed from the
        # live registry. This is not a tombstone, so a later deploy may add
        # them again.
        with self._connect() as conn:
            tracked = [row[0] for row in conn.execute("SELECT server_id FROM mcp_bootstrap_state").fetchall()]
            for server_id in tracked:
                if server_id not in present:
                    conn.execute(
                        "UPDATE mcp_servers SET deleted=1,enabled=0,updated_at=? WHERE id=?",
                        (time.time(), server_id),
                    )
                    conn.execute("DELETE FROM mcp_bootstrap_state WHERE server_id=?", (server_id,))
        return imported
