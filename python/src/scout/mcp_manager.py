"""MCP client lifecycle and LangChain tool adapters."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import AsyncExitStack
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import ConfigDict, create_model
import httpx

from .mcp_store import McpStore
from .execution.worker_auth import require_worker_secret, sign_request_body
from .execution.models import CapabilityRequest

logger = logging.getLogger(__name__)
MAX_MCP_DESCRIPTION = 2048
MAX_MCP_RESULT = 100_000


def _args_model(server_id: str, tool: dict[str, Any]):
    schema = tool.get("inputSchema") or {"type": "object", "properties": {}}
    properties = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    fields: dict[str, tuple[Any, Any]] = {}
    for name in properties:
        fields[str(name)] = (Any, ... if name in required else None)
    model = create_model(f"Mcp_{server_id}_{tool['name']}_Args", __config__=ConfigDict(extra="allow"), **fields)
    return model


def _result_text(result: Any) -> str:
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        # MCP servers commonly provide the same result twice: structuredContent
        # for capable clients and a text fallback for older ones. Prefer the
        # structured form so field boundaries survive without duplication.
        value = json.dumps(structured, ensure_ascii=False, indent=2, default=str)
    else:
        parts: list[str] = []
        for item in getattr(result, "content", []) or []:
            text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
            if text:
                parts.append(str(text))
            uri = item.get("uri") if isinstance(item, dict) else getattr(item, "uri", None)
            if uri:
                parts.append(f"[resource: {uri}]")
        value = "\n".join(parts) or str(result)
    if len(value) > MAX_MCP_RESULT:
        original_chars = len(value)
        marker = (
            "\n\n… [MCP output exceeded the emergency context bound: "
            f"{original_chars:,} original characters; "
            f"{MAX_MCP_RESULT:,} retained across the beginning and end] …\n\n"
        )
        available = max(2, MAX_MCP_RESULT - len(marker))
        head_chars = (available * 2) // 3
        tail_chars = available - head_chars
        value = value[:head_chars] + marker + value[-tail_chars:]
    if getattr(result, "isError", False):
        return "[MCP tool error] " + value
    return value


class McpManager:
    """Owns long-lived remote MCP connections for one Scout process."""

    def __init__(self, store: McpStore | None = None) -> None:
        self.store = store or McpStore()
        self._stack = AsyncExitStack()
        self._connection_stacks: dict[str, AsyncExitStack] = {}
        self._sessions: dict[str, Any] = {}
        self._connection_keys: dict[tuple[str, str], str] = {}
        self._worker_connections: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._health: dict[str, dict[str, Any]] = {}
        self._revision = 0

    @property
    def revision(self) -> int:
        return self._revision

    async def close(self) -> None:
        # Container MCP processes live in the execution worker, not in this
        # process.  Explicitly tear them down so deploys/reloads do not leave
        # unbounded child containers behind.  Cleanup is best-effort because
        # the worker may already be shutting down.
        for connection_id in list(self._worker_connections):
            try:
                await self._worker_request("DELETE", f"/mcp/{connection_id}", {})
            except Exception:
                logger.debug("failed to close MCP worker connection %s", connection_id, exc_info=True)
        self._worker_connections.clear()
        for stack in list(self._connection_stacks.values()):
            try:
                await stack.aclose()
            except Exception:
                logger.debug("failed to close MCP connection", exc_info=True)
        self._connection_stacks.clear()
        await self._stack.aclose()
        self._sessions.clear()
        self._connection_keys.clear()

    def health(self) -> dict[str, dict[str, Any]]:
        return dict(self._health)

    async def connect(self, server_id: str, *, credential: str | None = None, user_id: str | None = None) -> dict[str, Any]:
        server = self.store.get_server(server_id)
        if not server:
            raise ValueError("MCP server not found")
        if server["transport"] == "container_stdio":
            if user_id is None:
                raise RuntimeError("container MCP connections require a user")
            return await self._connect_container(server, user_id)
        shared_token = self.store.server_credential(server_id)
        connection_key = server_id if (user_id is None or (credential is None and shared_token)) else f"{server_id}:{user_id}"
        lock = self._locks.setdefault(connection_key, asyncio.Lock())
        async with lock:
            if connection_key in self._sessions:
                return self._health.get(connection_key, {"status": "connected"})
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
            headers = {}
            token = credential or shared_token
            if token:
                headers["Authorization"] = f"Bearer {token}"
            connection_stack = AsyncExitStack()
            await connection_stack.__aenter__()
            try:
                streams = await connection_stack.enter_async_context(streamablehttp_client(server["url"], headers=headers or None))
                session = await connection_stack.enter_async_context(ClientSession(streams[0], streams[1]))
                await asyncio.wait_for(session.initialize(), timeout=30)
                listed = await asyncio.wait_for(session.list_tools(), timeout=30)
                tools = []
                for item in listed.tools:
                    data = item.model_dump(by_alias=True, exclude_none=True) if hasattr(item, "model_dump") else item.dict()
                    data["description"] = str(data.get("description") or "")[:MAX_MCP_DESCRIPTION]
                    tools.append(data)
                self.store.upsert_tools(server_id, tools)
                self._sessions[connection_key] = session
                self._connection_stacks[connection_key] = connection_stack
                if user_id is not None:
                    self._connection_keys[(server_id, str(user_id))] = connection_key
                self._health[connection_key] = {"status": "connected", "tool_count": len(tools)}
                self._health[server_id] = self._health[connection_key]
                self._revision += 1
                return self._health[connection_key]
            except Exception as exc:
                await connection_stack.aclose()
                logger.warning("MCP %s unavailable: %s", server_id, exc)
                self._health[server_id] = {"status": "unavailable", "error": str(exc)[:300]}
                raise

    async def refresh(self, server_id: str, *, credential: str | None = None, user_id: str | None = None) -> dict[str, Any]:
        await self.disconnect(server_id, user_id=user_id)
        if user_id is None and (server := self.store.get_server(server_id)) and server.get("transport") == "container_stdio":
            raise RuntimeError("container MCP integrations refresh when a user enables them")
        return await self.connect(server_id, credential=credential, user_id=user_id)

    async def disconnect(self, server_id: str, *, user_id: str | None = None) -> None:
        """Drop cached transport state so changed settings apply next turn."""
        if user_id is None:
            for key in [key for key in self._sessions if key == server_id or key.startswith(f"{server_id}:")]:
                self._sessions.pop(key, None)
                stack = self._connection_stacks.pop(key, None)
                if stack:
                    await stack.aclose()
        else:
            key = self._connection_keys.pop((server_id, str(user_id)), f"{server_id}:{user_id}")
            self._sessions.pop(key, None)
            stack = self._connection_stacks.pop(key, None)
            if stack:
                await stack.aclose()
        worker_keys = (
            [f"{server_id}:{user_id}"] if user_id is not None
            else [key for key in self._worker_connections if key.startswith(f"{server_id}:")]
        )
        for key in worker_keys:
            if self._worker_connections.pop(key, None):
                try:
                    await self._worker_request("DELETE", f"/mcp/{key}", {})
                except Exception:
                    logger.debug("failed to close MCP worker connection %s", key, exc_info=True)

    async def ensure_user_tools(self, user_id: int | str, *, approval_callback=None) -> list[Any]:
        adapters: list[Any] = []
        for server in self.store.list_for_user(user_id):
            cfg = self.store.user_config(server["id"], user_id)
            # A user must explicitly enable every integration. Admin-shared
            # credentials remove the connect requirement but not the enable.
            if not cfg["enabled"]:
                continue
            # A deployment/admin credential owns authentication for the whole
            # integration. Personal credentials remain available only for MCPs
            # that do not have a shared credential configured.
            credential = None if self.store.has_shared_credential(server["id"]) else cfg.get("credential")
            try:
                await self.connect(server["id"], credential=credential, user_id=str(user_id))
            except Exception:
                continue
            for definition in self.store.list_tools(server["id"]):
                adapters.append(self._adapter(server, definition, str(user_id), approval_callback))
        return adapters

    async def _connect_container(self, server: dict[str, Any], user_id: str) -> dict[str, Any]:
        key = f"{server['id']}:{user_id}"
        if key in self._worker_connections:
            return self._health.get(key, {"status": "connected"})
        payload = {"connection_id": key, "user_id": str(user_id), "session_id": "mcp", "image": server["image"], "command": server.get("command") or [], "args": server.get("args") or []}
        response = await self._worker_request("POST", "/mcp/connect", payload)
        self.store.upsert_tools(server["id"], response.get("tools") or [])
        self._worker_connections[key] = key
        health = {"status": "connected", "tool_count": len(response.get("tools") or [])}
        self._health[key] = health
        self._health[server["id"]] = health
        self._revision += 1
        return health

    async def _worker_request(self, method: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        secret = require_worker_secret()
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        headers = {"Authorization": f"Bearer {secret}", "Content-Type": "application/json", **sign_request_body(payload, secret=secret)}
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.request(method, f"{__import__('os').environ.get('SCOUT_WORKER_URL', 'http://execution-worker:7891').rstrip('/')}{path}", content=body, headers=headers)
            response.raise_for_status()
            return response.json()

    async def _invoke(self, server_id: str, user_id: str, tool_name: str, kwargs: dict[str, Any]) -> str:
        server = self.store.get_server(server_id) or {}
        if server.get("transport") == "container_stdio":
            payload = await self._worker_request("POST", "/mcp/call", {"connection_id": f"{server_id}:{user_id}", "user_id": user_id, "session_id": "mcp", "name": tool_name, "arguments": kwargs})
            class Result:
                content = payload.get("content", [])
                structuredContent = payload.get("structuredContent")
                isError = payload.get("isError", False)
            return _result_text(Result())
        connection_key = self._connection_keys.get((server_id, user_id), server_id)
        result = await asyncio.wait_for(self._sessions[connection_key].call_tool(tool_name, kwargs), timeout=60)
        return _result_text(result)

    def _adapter(self, server: dict[str, Any], definition: dict[str, Any], user_id: str, approval_callback=None) -> StructuredTool:
        server_id = server["id"]
        tool_name = definition["name"]
        exposed_name = f"mcp__{server_id}__{tool_name}"
        async def invoke(**kwargs: Any) -> str:
            if approval_callback is not None:
                decision, feedback = await approval_callback(CapabilityRequest(
                    capability="mcp_tool",
                    reason=f"Call {server['name']} · {tool_name}",
                    scope={"server_id": server_id, "tool": tool_name, "arguments": kwargs},
                    command_summary=f"MCP {server['name']} / {tool_name}",
                ))
                if decision in {"deny", "no"}:
                    return f"[MCP TOOL DENIED] {feedback or 'Approval was denied.'}"
            return await self._invoke(server_id, user_id, tool_name, kwargs)

        adapter = StructuredTool.from_function(
            coroutine=invoke,
            name=exposed_name,
            description=f"[{server['name']}] {definition.get('description') or tool_name}"[:MAX_MCP_DESCRIPTION],
            args_schema=_args_model(server_id, definition),
        )
        # StructuredTool is a Pydantic model and rejects undeclared attributes
        # through normal setattr on current LangChain releases. These local
        # routing markers are intentionally non-serialized runtime metadata.
        object.__setattr__(adapter, "mcp_server_id", server_id)
        object.__setattr__(adapter, "mcp_tool_name", tool_name)
        object.__setattr__(adapter, "mcp_read_only", bool(definition.get("read_only")))
        return adapter
