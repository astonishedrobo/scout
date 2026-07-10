"""Scout agent -- conversational data research interface with tool calling."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from ..config import AppConfig, load_config
from ..retriever import BM25Retriever, RetrieverProxy
from ..permissions import ProfileConfig, profile_from_user, resolve_profile
from ..memories import ensure_memory_layout, load_memory_registry
from .memory_prompt import build_memory_instructions
from ..path_display import redact_paths
from ..skills import load_layered_instructions, load_skills, resolve_focus_path
from .exceptions import ProviderRateLimitError
from .graph import ApprovalFn, CapabilityApprovalFn, PromotionApprovalFn, build_graph
from .prompts import build_system_prompt
from .session import PersistentPythonSession
from .file_guard import WorkspaceGuard
from .tools import make_tools

logger = logging.getLogger(__name__)

_TOOL_OUTPUT_PREVIEW_CHARS = 500


def preview_tool_output(content: object, max_chars: int = _TOOL_OUTPUT_PREVIEW_CHARS) -> str:
    """Return a bounded UI preview that makes omitted output explicit."""
    text = content if isinstance(content, str) else str(content or "")
    if len(text) <= max_chars:
        return text

    hidden = text[max_chars:]
    hidden_lines = max(1, len(hidden.splitlines()))
    line_label = "line" if hidden_lines == 1 else "lines"
    return (
        f"{text[:max_chars]}\n\n"
        f"… +{hidden_lines} more {line_label} "
        f"({len(hidden):,} characters hidden)"
    )


def thinking_block_from_args(args: dict) -> tuple[str, str]:
    """Return (title, content) for a think tool call."""
    content = str(args.get("content") or args.get("reflection") or "").strip()
    title = str(args.get("title") or "").strip()
    if not content and title:
        content = title
        title = ""
    if not content:
        return "", ""
    if not title:
        first_line = content.split("\n", 1)[0].strip()
        # Prefer first sentence as the collapsed header.
        for sep in (". ", "? ", "! "):
            idx = first_line.find(sep)
            if 0 < idx <= 90:
                title = first_line[: idx + 1].strip()
                break
        if not title:
            title = first_line if len(first_line) <= 90 else first_line[:87].rstrip() + "..."
    return title, content


__all__ = ["ScoutAgent", "ProviderRateLimitError", "thinking_block_from_args"]


def _tool_arg_summary(name: str, args: dict) -> str:
    if name in {"read_file"}:
        return f"read `{args.get('path', '?')}`"
    if name == "present_files":
        paths = args.get("filepaths") or args.get("paths") or args.get("path") or []
        if isinstance(paths, str):
            paths = [paths]
        if isinstance(paths, list) and paths:
            shown = ", ".join(f"`{p}`" for p in paths[:3])
            extra = f" +{len(paths) - 3} more" if len(paths) > 3 else ""
            return f"present {shown}{extra}"
        return "present files"
    if name == "write_file":
        return f"wrote `{args.get('path', '?')}`"
    if name == "list_files":
        return f"listed `{args.get('directory', '.')}`"
    if name == "search_documents":
        q = args.get("query", "?")
        p = args.get("path") or ""
        return f"query: {q} in `{p}`" if p else f"query: {q}"
    if name in {"run_shell", "exec_command", "write_stdin", "run_node"}:
        desc = args.get("description", "")
        if desc:
            return desc[:80]
        if name == "exec_command":
            return f"`{args.get('cmd', '')[:60]}`"
        if name == "write_stdin":
            sid = args.get("session_id", "?")
            return f"session {sid}" + (f" +{len(args.get('chars', ''))} chars" if args.get("chars") else " (poll)")
        if name == "run_shell":
            return f"`{args.get('command', '')[:60]}`"
        code = args.get("code", "")
        first_line = code.split("\n", 1)[0][:60]
        return f"`{first_line}`" if first_line else f"ran {name}"
    if name == "think":
        text = str(args.get("content") or args.get("reflection") or args.get("title") or "")
        return text[:80] + ("..." if len(text) > 80 else "")
    return ", ".join(f"{k}={str(v)[:30]}" for k, v in list(args.items())[:3]) or ""


def _build_tool_summary(tool_steps: list[tuple[str, dict, str]]) -> str:
    if not tool_steps:
        return "No operations were performed."

    parts: list[str] = []
    for name, args, output in tool_steps:
        desc = _tool_arg_summary(name, args)
        header = f"**{name}**"
        if desc:
            header += f" — {desc}"
        snippet = output.strip().replace("\n", " ")[:150]
        if len(output.strip()) > 150:
            snippet += "…"
        if snippet:
            parts.append(f"{header}\n> {snippet}")
        else:
            parts.append(header)

    return "\n\n".join(parts)


def _message_text(content: object) -> str:
    """Extract user-visible text from LangChain message content."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in {"text", "input_text"} and item.get("text"):
                    parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(content or "")


class ScoutAgent:
    """Conversational data research agent backed by the execution sandbox."""

    def __init__(
        self,
        config_path: str | Path | None = None,
        *,
        cwd: str | Path | None = None,
        approval_callback: ApprovalFn | None = None,
        capability_approval_callback: CapabilityApprovalFn | None = None,
        approval_callback_args: tuple[Any, ...] | None = None,
        config: AppConfig | None = None,
        read_only: bool = False,
        guard: "WorkspaceGuard | None" = None,
        retriever: "BM25Retriever | RetrieverProxy | None" = None,
        user_id: str = "default",
        session_id: str = "default",
        server_mode: bool = False,
        shared_dir: Path | None = None,
        grant_store: CapabilityGrantStore | None = None,
        profile: ProfileConfig | None = None,
    ) -> None:
        self._cwd = str(Path(cwd or os.getcwd()).resolve())
        self._guard = guard
        self._user_id = user_id
        self._session_id = session_id
        self._server_mode = server_mode
        self._shared_dir = str(shared_dir.resolve()) if shared_dir else None
        if config:
            self._config = config
        else:
            self._config = load_config(config_path, cwd=self._cwd)
        cfg = self._config.agent

        if profile is None:
            profile = resolve_profile(getattr(cfg, "permission_profile", None))
        if read_only:
            profile = resolve_profile("analyst")
        self._profile = profile
        cfg.disable_write_tools = profile.disable_write_tools

        self._config.llm.inject_env_vars()
        self._retriever = retriever if retriever is not None else BM25Retriever(self._config)

        data_dir = self._resolve_data_dir()
        personal_dir = Path(data_dir)

        from ..execution.grants import CapabilityGrantStore
        from ..execution.service import ExecutionService

        # Execution service (primary path for all code execution)
        promotion_cb = None
        capability_cb = None
        if approval_callback and approval_callback_args:
            sid, uid = approval_callback_args[0], approval_callback_args[1]

            async def promotion_cb(tool_name, diffs, args):
                return await approval_callback(sid, uid, tool_name, diffs, args)

        if capability_approval_callback and approval_callback_args:
            sid, uid = approval_callback_args[0], approval_callback_args[1]
            _cap_cb = capability_approval_callback

            async def capability_cb(cap):
                return await _cap_cb(sid, uid, cap)

        self._execution: ExecutionService | None = None
        if self._config.execution.enabled:
            self._execution = ExecutionService(
                config=self._config,
                guard=guard,
                personal_dir=personal_dir,
                shared_dir=shared_dir,
                user_id=str(user_id),
                session_id=str(session_id),
                server_mode=server_mode,
                grant_store=grant_store,
                capability_approval=capability_cb,
                promotion_approval=promotion_cb,
                allow_shared_write=profile.allow_shared_write,
                shell_enabled=profile.shell_enabled,
                personal_write=profile.personal_write,
            )
        self._request_permissions_fn = None

        # Legacy session fallback only in local mode with explicit insecure opt-in.
        self._session: PersistentPythonSession | None = None
        if (
            not server_mode
            and (
                self._execution is None
                or (not self._execution.enabled and self._config.execution.allow_insecure_local_fallback)
            )
        ):
            allowed_paths = None
            if self._guard is not None:
                allowed_paths = [str(self._guard._personal), str(self._guard._shared)]
            self._session = PersistentPythonSession(
                conda_env=cfg.conda_env,
                cwd=data_dir,
                timeout=cfg.code_timeout,
                python_path=cfg.python_path,
                allowed_paths=(allowed_paths or []) + [str(Path(data_dir) / ".scout-cache")],
                cache_dir=Path(data_dir) / ".scout-cache",
            )

        self._data_dir = data_dir
        self._approval_callback = approval_callback
        self._approval_callback_args = approval_callback_args
        self._final_approval = approval_callback
        if approval_callback and approval_callback_args:
            orig_cb = approval_callback
            async def wrapped_callback(name, diffs, args):
                return await orig_cb(*approval_callback_args, name, diffs, args)
            self._final_approval = wrapped_callback

        self._run_config = {
            "recursion_limit": max(cfg.max_iterations * 3, 50),
            "run_name": "scout-agent",
            "tags": ["scout", "server" if server_mode else "local"],
            "metadata": {
                "scout_user_id": str(user_id),
                "scout_session_id": str(session_id),
                "scout_model": cfg.model,
                "scout_server_mode": server_mode,
            },
        }
        self._messages: list = []
        self._focus_path = None
        self._rebuild_graph(focus_path=None)

    def _rebuild_graph(self, focus_path: Path | str | None = None) -> None:
        cfg = self._config.agent
        profile = self._profile
        defer_skills = self._config.skills.defer_loading
        skills_text = load_layered_instructions(
            self._cwd, focus_path=focus_path, defer_skills=defer_skills,
        )
        memory_instructions = ""
        if self._config.memories.use_memories:
            root = ensure_memory_layout(
                self._user_id, personal_dir=self._cwd, server_mode=self._server_mode,
            )
            memory_content = load_memory_registry(
                self._user_id, personal_dir=self._cwd, server_mode=self._server_mode,
            )
            max_chars = self._config.memories.max_summary_tokens * 4
            if len(memory_content) > max_chars:
                memory_content = memory_content[:max_chars]
            memory_instructions = build_memory_instructions(str(root), memory_content)
        tools = make_tools(
            self._retriever,
            self._data_dir,
            disable_write_tools=cfg.disable_write_tools,
            guard=self._guard,
            execution_service=self._execution,
            session=self._session,
            allowed_tools=profile.allowed_tools,
            personal_dir=self._cwd,
            server_mode=self._server_mode,
            user_id=str(self._user_id),
            use_memories=self._config.memories.use_memories,
            allow_request_permissions=(
                self._config.permissions.allow_request_permissions
                and profile.can_request_permissions
            ),
            request_permissions_fn=self._request_permissions_fn,
        )
        system_prompt = build_system_prompt(
            self._data_dir,
            config=self._config,
            skills_text=skills_text,
            disable_write_tools=cfg.disable_write_tools,
            focus_path=focus_path,
            memory_instructions=memory_instructions,
            allowed_tools=profile.allowed_tools,
        )
        self._graph = build_graph(
            cfg, tools, system_prompt,
            approval_callback=self._final_approval,
            cwd=self._cwd,
            data_dir=self._data_dir,
            execution_service=self._execution,
            hooks_enabled=self._config.hooks.enabled,
            llm_client_kwargs=self._config.llm.get_model_client_kwargs(cfg.model),
            personal_dir=self._cwd,
            shared_dir=self._shared_dir,
            server_mode=self._server_mode,
        )

    def set_request_permissions_fn(self, fn) -> None:
        self._request_permissions_fn = fn
        self._rebuild_graph(focus_path=self._focus_path)

    def set_active_profile(self, profile_name: str) -> None:
        from ..permissions import resolve_profile
        self._profile = resolve_profile(profile_name)
        self._config.agent.disable_write_tools = self._profile.disable_write_tools
        if self._execution and self._execution._orchestrator:
            orch = self._execution._orchestrator
            orch._allow_shared_write = self._profile.allow_shared_write
            orch._shell_enabled = self._profile.shell_enabled
            orch._personal_write = self._profile.personal_write
        self._rebuild_graph(focus_path=self._focus_path)

    def set_model(self, model: str) -> None:
        """Switch models while preserving active conversation messages."""
        self._config.agent.model = model
        self._rebuild_graph(focus_path=self._focus_path)

    def _record_memory_citations(self, text: str) -> None:
        from ..memories_citations import parse_memory_citation
        from ..memory_store import open_memory_store
        citation = parse_memory_citation(text)
        if not citation:
            return
        ids = citation.rollout_ids
        if not ids:
            return
        try:
            store = open_memory_store(
                self._cwd if self._server_mode else None,
                self._server_mode,
            )
            store.record_usage(ids)
        except Exception:
            logger.debug("Could not record memory usage", exc_info=True)

    def set_focus_from_attachments(self, attachment_paths: list[str] | None) -> None:
        """Refresh layered instructions and manifest for @-attached files."""
        focus = resolve_focus_path(self._cwd, attachment_paths)
        if focus == self._focus_path:
            return
        self._focus_path = focus
        self._rebuild_graph(focus_path=focus)

    async def chat(self, user_message: str, attachments: list[str] | None = None) -> str:
        from .multimodal import build_human_message
        self._messages.append(build_human_message(user_message, attachments))
        try:
            result = await self._graph.ainvoke(
                {"messages": self._messages, "iteration": 0},
                config=self._run_config,
            )
        except ProviderRateLimitError:
            self._messages.pop()
            raise
        self._messages = result["messages"]
        for msg in reversed(self._messages):
            if isinstance(msg, AIMessage) and not msg.tool_calls:
                return redact_paths(msg.content or "", self._cwd, self._shared_dir)
        return ""

    async def stream(self, user_message: str, attachments: list[str] | None = None) -> AsyncIterator[dict[str, Any]]:
        import asyncio

        from .multimodal import build_human_message
        self._messages.append(build_human_message(user_message, attachments))
        new_messages: list = []
        response_emitted = False
        last_ai_content = ""
        tool_steps: list[tuple[str, dict, str]] = []
        _pending_calls: dict[str, dict[str, Any]] = {}

        output_q: asyncio.Queue = asyncio.Queue()
        graph_q: asyncio.Queue = asyncio.Queue()
        if self._execution:
            self._execution.set_output_sink(output_q)

        yield {"type": "status", "message": "Thinking through the request"}

        async def _drain_graph() -> None:
            try:
                async for chunk in self._graph.astream(
                    {"messages": self._messages, "iteration": 0},
                    config=self._run_config,
                ):
                    await graph_q.put(("chunk", chunk))
            except Exception as exc:
                await graph_q.put(("error", exc))
            finally:
                await graph_q.put(("done", None))

        graph_task = asyncio.create_task(_drain_graph())

        def _process_graph_chunk(chunk: dict) -> list[dict[str, Any]]:
            nonlocal last_ai_content, response_emitted
            events: list[dict[str, Any]] = []
            for _node_name, state_update in chunk.items():
                for msg in state_update.get("messages", []):
                    new_messages.append(msg)
                    if isinstance(msg, AIMessage):
                        user_input_request = msg.additional_kwargs.get("user_input_request")
                        if user_input_request:
                            response_emitted = True
                            events.append(user_input_request)
                            continue
                        visible_text = _message_text(msg.content).strip()
                        if msg.tool_calls:
                            # User-facing prose that accompanies tool calls belongs
                            # in the interleaved timeline, not as a collapsed
                            # "activity group" title.
                            if visible_text:
                                safe_text = redact_paths(visible_text, self._cwd, self._shared_dir)
                                events.append({
                                    "type": "assistant_text",
                                    "content": safe_text,
                                    "tool_call_id": msg.tool_calls[0]["id"],
                                })
                            for tc in msg.tool_calls:
                                args = tc.get("args", {}) or {}
                                _pending_calls[tc["id"]] = {
                                    "name": tc["name"],
                                    "args": args,
                                }
                                if tc["name"] == "think":
                                    title, body = thinking_block_from_args(args)
                                    if body:
                                        events.append({
                                            "type": "thinking",
                                            "title": redact_paths(
                                                title, self._cwd, self._shared_dir,
                                            ),
                                            "content": redact_paths(
                                                body, self._cwd, self._shared_dir,
                                            ),
                                            "tool_call_id": tc["id"],
                                        })
                                    continue
                                events.append({
                                    "type": "tool_call",
                                    "name": tc["name"],
                                    "args": args,
                                    "tool_call_id": tc["id"],
                                })
                        if visible_text and not msg.tool_calls:
                            safe_content = redact_paths(visible_text, self._cwd, self._shared_dir)
                            last_ai_content = safe_content
                            response_emitted = True
                            self._record_memory_citations(safe_content)
                            events.append({"type": "response", "content": safe_content})
                    elif isinstance(msg, ToolMessage):
                        full_output = msg.content if isinstance(msg.content, str) else str(msg.content or "")
                        output_preview = preview_tool_output(full_output)
                        name = msg.name or ""
                        pending = _pending_calls.pop(msg.tool_call_id, {})
                        args = pending.get("args", {})
                        if pending.get("name") == "think" or name == "think":
                            continue
                        tool_steps.append((name, args, output_preview))
                        events.append({
                            "type": "tool_result",
                            "name": name,
                            "output": full_output,
                            "output_preview": output_preview,
                            "artifacts": msg.additional_kwargs.get("artifacts", []),
                            "file_changes": msg.additional_kwargs.get("file_changes", []),
                            "tool_call_id": msg.tool_call_id,
                        })
            return events

        def _seal_pending_tools() -> None:
            """Close open tool calls so history stays valid for the next turn."""
            for tc_id, pending in list(_pending_calls.items()):
                name = pending.get("name") or "unknown"
                _pending_calls.pop(tc_id, None)
                if name == "think":
                    continue
                note = "[Interrupted by user — tool did not finish]"
                new_messages.append(ToolMessage(
                    content=note,
                    name=name,
                    tool_call_id=tc_id,
                ))
                tool_steps.append((name, pending.get("args", {}), note))

        graph_done = False
        committed = False
        discard_turn = False
        try:
            while not graph_done:
                graph_get = asyncio.ensure_future(graph_q.get())
                chunk_get = asyncio.ensure_future(output_q.get())
                finished, pending = await asyncio.wait(
                    {graph_get, chunk_get},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()

                for task in finished:
                    if task is chunk_get:
                        try:
                            chunk_event = task.result()
                            yield chunk_event
                        except Exception:
                            pass
                    elif task is graph_get:
                        kind, payload = task.result()
                        if kind == "chunk":
                            for ev in _process_graph_chunk(payload):
                                yield ev
                        elif kind == "error":
                            raise payload
                        elif kind == "done":
                            graph_done = True

            while not output_q.empty():
                try:
                    yield output_q.get_nowait()
                except asyncio.QueueEmpty:
                    break

            if not response_emitted and new_messages:
                content = last_ai_content or _build_tool_summary(tool_steps)
                yield {"type": "response", "content": content}

            self._messages.extend(new_messages)
            committed = True
        except ProviderRateLimitError:
            # Drop the user turn that never got a model reply.
            discard_turn = True
            self._messages.pop()
            raise
        except Exception:
            # Keep partial progress on tool/model errors (not rate-limit).
            if not committed:
                _seal_pending_tools()
                self._messages.extend(new_messages)
                committed = True
            if not response_emitted and tool_steps:
                yield {"type": "response", "content": _build_tool_summary(tool_steps)}
            raise
        finally:
            if self._execution:
                self._execution.set_output_sink(None)
            if not graph_task.done():
                graph_task.cancel()
            # Cancel / GeneratorExit often bypasses except CancelledError on
            # async generators — always seal partial history so Stop keeps context.
            if not committed and not discard_turn:
                _seal_pending_tools()
                self._messages.extend(new_messages)
                committed = True

    def reset(self) -> None:
        self._messages.clear()
        logger.info("Conversation history cleared.")

    def _resolve_data_dir(self) -> str:
        if self._guard is not None:
            return self._cwd
        if self._config.data_paths:
            for key in ("data_dir", "climate_csv", "csv_dir", "text_dir"):
                try:
                    p = self._config.get_path(key)
                    s = str(p)
                    for folder in ("meta_files", "csv_files", "text_files", "json_files", "pdf_files"):
                        if f"/{folder}" in s:
                            return s.rsplit(f"/{folder}", 1)[0]
                    if p.is_dir():
                        return str(p)
                    return str(p.parent)
                except KeyError:
                    continue
        return self._cwd

    async def __aenter__(self) -> "ScoutAgent":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._execution:
            await self._execution.close()
        if self._session:
            self._session.close()

    @property
    def execution_service(self):
        return self._execution
