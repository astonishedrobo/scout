"""Scout agent -- conversational data research interface with tool calling.

Usage::

    import asyncio
    from scout.agent import ScoutAgent

    async def main():
        async with ScoutAgent(project_dir=".") as agent:
            reply = await agent.chat("Tell me about the dataset")
            print(reply)

            # Follow-up (conversation context is preserved)
            reply = await agent.chat("Compare the top entries")
            print(reply)

    asyncio.run(main())
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from ..config import AppConfig, load_config
from ..pdf_reader import PDFConverter
from ..retriever import BM25Retriever
from ..skills import load_skills
from .exceptions import ProviderRateLimitError
from .graph import ApprovalFn, build_graph
from .prompts import build_system_prompt
from .session import PersistentPythonSession
from .tools import make_tools

logger = logging.getLogger(__name__)

__all__ = ["ScoutAgent", "ProviderRateLimitError"]


def _tool_arg_summary(name: str, args: dict) -> str:
    """Extract a short human-readable description from tool args."""
    if name == "read_file":
        return f"read `{args.get('path', '?')}`"
    if name == "write_file":
        return f"wrote `{args.get('path', '?')}`"
    if name == "list_files":
        return f"listed `{args.get('directory', '.')}`"
    if name == "read_pdf":
        p = args.get("path", "?")
        q = args.get("query", "")
        return f"searched `{p}`" if q else f"read `{p}`"
    if name == "search_documents":
        return f"query: {args.get('query', '?')}"
    if name == "run_code":
        desc = args.get("description", "")
        if desc:
            return desc[:80]
        code = args.get("code", "")
        first_line = code.split("\n", 1)[0][:60]
        return f"`{first_line}`" if first_line else "ran code"
    if name == "think":
        text = args.get("reflection", "")
        return text[:80] + ("..." if len(text) > 80 else "")
    return ", ".join(f"{k}={str(v)[:30]}" for k, v in list(args.items())[:3]) or ""


def _build_tool_summary(tool_steps: list[tuple[str, dict, str]]) -> str:
    """Format completed tool steps into a structured markdown summary."""
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


class ScoutAgent:
    """Conversational data research agent backed by a persistent Python session.

    Use as an async context manager to ensure the subprocess is
    cleaned up on exit.
    """

    def __init__(
        self,
        config_path: str | Path | None = None,
        *,
        cwd: str | Path | None = None,
        approval_callback: ApprovalFn | None = None,
        approval_callback_args: tuple[Any, ...] | None = None,
        config: AppConfig | None = None,
        read_only: bool = False,
    ) -> None:
        self._cwd = str(Path(cwd or os.getcwd()).resolve())
        if config:
            self._config = config
        else:
            self._config = load_config(config_path, cwd=self._cwd)
        cfg = self._config.agent

        if read_only:
            cfg.disable_write_tools = True

        # Inject API keys from llm.providers into environment
        self._config.llm.inject_env_vars()

        # ── PDF conversion (cache text for BM25 indexing) ─────────────
        self._convert_pdfs()

        # ── BM25 retriever ────────────────────────────────────────────
        self._retriever = BM25Retriever(self._config)

        # ── Persistent Python session ─────────────────────────────────
        data_dir = self._resolve_data_dir()
        self._session = PersistentPythonSession(
            conda_env=cfg.conda_env,
            cwd=data_dir,
            timeout=cfg.code_timeout,
            python_path=cfg.python_path,
        )

        # ── Load domain skills ────────────────────────────────────────
        skills_text = load_skills(self._cwd)

        # ── LangGraph tools + graph ──────────────────────────────────
        tools = make_tools(self._session, self._retriever, data_dir, disable_write_tools=cfg.disable_write_tools)
        system_prompt = build_system_prompt(
            data_dir, config=self._config, skills_text=skills_text, disable_write_tools=cfg.disable_write_tools
        )

        # Wrap approval callback with args if provided
        final_approval = approval_callback
        if approval_callback and approval_callback_args:
            orig_cb = approval_callback
            async def wrapped_callback(name, diffs, args):
                return await orig_cb(*approval_callback_args, name, diffs, args)
            final_approval = wrapped_callback

        self._graph = build_graph(
            cfg, tools, system_prompt,
            approval_callback=final_approval,
            cwd=self._cwd,
            data_dir=data_dir,
        )

        self._run_config = {
            "recursion_limit": max(cfg.max_iterations * 3, 50),
        }

        # ── Conversation state ───────────────────────────────────────
        self._messages: list = []

    # ── Public API ───────────────────────────────────────────────────

    async def chat(self, user_message: str) -> str:
        """Send a user message and return the final assistant reply.

        Raises
        ------
        ProviderRateLimitError
            If the LLM provider returns a rate-limit / quota error.
            The conversation history is **not** modified — the caller
            can retry the same message later.
        """
        self._messages.append(HumanMessage(content=user_message))

        try:
            result = await self._graph.ainvoke(
                {"messages": self._messages, "iteration": 0},
                config=self._run_config,
            )
        except ProviderRateLimitError:
            # Roll back the HumanMessage we just appended so the
            # history stays clean for a retry.
            self._messages.pop()
            raise

        # Update our message history with everything the graph produced
        self._messages = result["messages"]

        # Find the last AI message that isn't a tool call
        for msg in reversed(self._messages):
            if isinstance(msg, AIMessage) and not msg.tool_calls:
                return msg.content or ""

        return ""

    async def stream(self, user_message: str) -> AsyncIterator[dict[str, Any]]:
        """Stream node-level events from the agent for a user message.

        Yields dicts with one of these shapes:

        - ``{"type": "tool_call", "name": ..., "args": ...}``
        - ``{"type": "tool_result", "name": ..., "output": ...}``
        - ``{"type": "response", "content": ...}`` (final AI text)

        Raises
        ------
        ProviderRateLimitError
            If the LLM provider returns a rate-limit / quota error.
            The conversation history is **not** modified.
        """
        self._messages.append(HumanMessage(content=user_message))

        new_messages: list = []  # track all messages produced by the graph
        response_emitted = False
        last_ai_content = ""
        tool_steps: list[tuple[str, dict, str]] = []  # (name, args, output)
        _pending_calls: dict[str, dict] = {}  # name -> args for pairing

        try:
            async for chunk in self._graph.astream(
                {"messages": self._messages, "iteration": 0},
                config=self._run_config,
            ):
                for _node_name, state_update in chunk.items():
                    for msg in state_update.get("messages", []):
                        new_messages.append(msg)

                        if isinstance(msg, AIMessage):
                            if msg.tool_calls:
                                for tc in msg.tool_calls:
                                    _pending_calls[tc["name"]] = tc.get("args", {})
                                    yield {
                                        "type": "tool_call",
                                        "name": tc["name"],
                                        "args": tc.get("args", {}),
                                    }

                            if msg.content:
                                last_ai_content = msg.content
                                if not msg.tool_calls:
                                    response_emitted = True
                                    yield {
                                        "type": "response",
                                        "content": msg.content,
                                    }

                        elif isinstance(msg, ToolMessage):
                            output = (msg.content or "")[:500]
                            name = msg.name or ""
                            args = _pending_calls.pop(name, {})
                            tool_steps.append((name, args, output))
                            yield {
                                "type": "tool_result",
                                "name": name,
                                "output": output,
                            }

        except ProviderRateLimitError:
            self._messages.pop()
            raise

        if not response_emitted and new_messages:
            content = last_ai_content or _build_tool_summary(tool_steps)
            yield {"type": "response", "content": content}

        # Update history: original messages + everything the graph added
        self._messages.extend(new_messages)

    def reset(self) -> None:
        """Clear conversation history (start a fresh dialogue)."""
        self._messages.clear()
        logger.info("Conversation history cleared.")

    # ── Lifecycle ────────────────────────────────────────────────────

    def _resolve_data_dir(self) -> str:
        """Find the data root directory from the config paths.

        Falls back to ``self._cwd`` when no ``data_paths`` are configured.
        """
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

    def _convert_pdfs(self) -> None:
        """Convert any new/stale PDFs to text before BM25 indexing."""
        try:
            pdf_dir = self._config.get_path("pdf_dir")
        except KeyError:
            return
        try:
            text_dir = self._config.get_path("text_dir")
        except KeyError:
            return
        converter = PDFConverter(pdf_dir, text_dir, parser=self._config.pdf.parser)
        converter.convert_all()

    async def __aenter__(self) -> "ScoutAgent":
        return self

    async def __aexit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        """Shut down the persistent session."""
        self._session.close()
