"""LangGraph ReAct graph with auto-context compression.

Builds a ``StateGraph`` that alternates between the LLM (agent node)
and tool execution, with a compression step that fires when token
usage exceeds a configurable fraction of the model's context window.

Part of the Scout agent framework.
"""

from __future__ import annotations

import logging
import base64
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Literal

import litellm
litellm.drop_params = True
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from ..artifacts import describe_artifact
from langgraph.graph import END, StateGraph

from .exceptions import ProviderRateLimitError
from .file_tracker import FileDiff, FileTracker, content_hash, exact_file_diff
from ..hooks import run_hook
from .patch import parse_patch
from .state import AgentState

if TYPE_CHECKING:
    from ..config import AgentConfig

ApprovalFn = Callable[[str, list[FileDiff], dict], Awaitable[tuple[str, str]]]
CapabilityApprovalFn = Callable[[object], Awaitable[tuple[str, str]]]
PromotionApprovalFn = ApprovalFn

_EXECUTION_TOOLS = frozenset({
    "run_code", "run_python", "run_shell", "exec_command", "write_stdin", "run_node",
})

logger = logging.getLogger(__name__)


def _init_chat_model(model: str, temperature: float) -> BaseChatModel:
    """Initialise a LangChain chat model from a LiteLLM-style model string.

    Uses ``ChatLiteLLM`` which is provider-agnostic — it accepts any
    model string that LiteLLM supports (e.g. ``groq/llama-3.1-8b-instant``,
    ``openai/gpt-4o``, ``anthropic/claude-3.5-sonnet``).
    """
    from langchain_litellm import ChatLiteLLM
    return ChatLiteLLM(model=model, temperature=temperature)

# ── Helpers ─────────────────────────────────────────────────────────────


def _count_tokens(model: str, messages: list) -> int:
    """Count tokens for *messages* using LiteLLM's tokeniser."""
    try:
        # litellm.token_counter accepts langchain-style dicts or
        # plain dicts with 'role'+'content'.
        lc_msgs = []
        for m in messages:
            if isinstance(m, dict):
                lc_msgs.append(m)
            else:
                # LangChain BaseMessage → dict
                lc_msgs.append({"role": _msg_role(m), "content": m.content or ""})
        return litellm.token_counter(model=model, messages=lc_msgs)
    except Exception:
        # Fallback: rough estimate (1 token ≈ 4 chars)
        total_chars = sum(len(m.content or "") if hasattr(m, "content") else 0 for m in messages)
        return total_chars // 4


def _get_context_window(model: str) -> int:
    """Return the model's max input tokens."""
    try:
        info = litellm.get_model_info(model=model)
        return info.get("max_input_tokens") or info.get("max_tokens") or 8192
    except Exception:
        logger.warning("Could not get model info for %s — defaulting to 8192", model)
        return 8192


def _msg_role(m: object) -> str:
    if isinstance(m, SystemMessage):
        return "system"
    if isinstance(m, HumanMessage):
        return "human"
    if isinstance(m, ToolMessage):
        return "tool"
    return "assistant"


def _parse_retry_after(error_msg: str) -> float | None:
    """Try to extract a retry-after duration (seconds) from the error string."""
    import re
    # Groq: "Please try again in 685ms" or "in 1.22s"
    match = re.search(r"try again in ([\d.]+)(ms|s)", error_msg)
    if match:
        val = float(match.group(1))
        if match.group(2) == "ms":
            val /= 1000.0
        return val
    return None


# ── Context compression ────────────────────────────────────────────────


def _compress_messages(
    messages: list,
    model: str,
    keep_recent: int,
    llm: BaseChatModel,
) -> list:
    """Summarise older messages to free up context space.

    Keeps the **system message** (index 0) and the last *keep_recent*
    messages verbatim.  Everything in between is replaced by a single
    ``SystemMessage`` containing a concise summary.
    """
    if len(messages) <= keep_recent + 2:
        return messages

    system_msg = messages[0] if isinstance(messages[0], SystemMessage) else None
    start_idx = 1 if system_msg else 0
    split = len(messages) - keep_recent
    old_messages = messages[start_idx:split]
    recent_messages = messages[split:]

    if not old_messages:
        return messages

    # Build a condensed text representation of old messages
    summary_parts: list[str] = []
    for m in old_messages:
        role = _msg_role(m)
        raw_content = m.content or ""
        if isinstance(raw_content, list):
            content = " ".join(
                str(item.get("text", ""))
                for item in raw_content
                if isinstance(item, dict) and item.get("type") == "text"
            )[:500]
            if any(isinstance(item, dict) and item.get("type") in {"image", "image_url"} for item in raw_content):
                content += " [image attached]"
        else:
            content = str(raw_content)[:500]
        if isinstance(m, AIMessage) and m.tool_calls:
            tool_names = [tc["name"] for tc in m.tool_calls]
            summary_parts.append(f"[assistant called: {', '.join(tool_names)}]")
        elif isinstance(m, ToolMessage):
            summary_parts.append(f"[tool result ({m.name}): {content[:200]}…]")
        elif content.strip():
            summary_parts.append(f"[{role}]: {content}")

    old_text = "\n".join(summary_parts)

    # Ask the LLM to compress
    compress_prompt = [
        SystemMessage(content=(
            "You are a conversation compressor. Summarise the following "
            "agent tool-call history into a concise paragraph. Preserve:\n"
            "- Key data findings (zone names, numeric values, file paths)\n"
            "- Decisions made and conclusions reached\n"
            "- Any errors encountered and how they were resolved\n"
            "Omit verbose tool outputs. Be concise (max 300 words)."
        )),
        HumanMessage(content=old_text),
    ]

    try:
        response = llm.invoke(compress_prompt)
        summary_text = response.content
    except Exception as exc:
        logger.warning("Compression LLM call failed: %s — using raw trim", exc)
        summary_text = old_text[:1500] + "\n…[truncated]"

    compressed = SystemMessage(content=f"[Conversation summary]\n{summary_text}")

    result = []
    if system_msg:
        result.append(system_msg)
    result.append(compressed)
    result.extend(recent_messages)

    logger.info(
        "Compressed %d messages → summary + %d recent",
        len(old_messages), len(recent_messages),
    )
    return result


# ── Graph builder ──────────────────────────────────────────────────────


def build_graph(
    agent_config: "AgentConfig",
    tools: list,
    system_prompt: str,
    approval_callback: ApprovalFn | None = None,
    cwd: str | None = None,
    data_dir: str | None = None,
    execution_service: object | None = None,
    *,
    hooks_enabled: bool = True,
    personal_dir: str | None = None,
    server_mode: bool = False,
) -> StateGraph:
    """Construct and compile the ReAct agent graph.

    Returns a compiled ``StateGraph`` ready for ``.invoke()`` /
    ``.stream()`` / ``.astream_events()``.

    Parameters
    ----------
    approval_callback : ApprovalFn | None
        ``async (tool_name, diffs, args) -> (action, feedback)``
        Called after a tool executes if file changes are detected.
        Returns ``("yes", "")`` to keep, ``("no", "")`` to revert,
        ``("edit", "")`` to open editor, ``("always", "")`` to
        auto-approve all future writes, or ``("suggest", "text")``.
    cwd : str | None
        Working directory for file-change tracking.
    data_dir : str | None
        Data directory used to resolve relative paths in write_file.
    """
    model_name = agent_config.model
    context_window = _get_context_window(model_name)
    threshold = agent_config.context_compress_threshold
    keep_recent = agent_config.compress_keep_recent
    max_iter = agent_config.max_iterations
    bad_req_retries = agent_config.bad_request_retries

    llm = _init_chat_model(model_name, agent_config.temperature)
    llm_with_tools = llm.bind_tools(tools)

    _tools_by_name = {t.name: t for t in tools}

    _MAX_TOOL_RESULT_CHARS = 3_000

    # ── Nodes ────────────────────────────────────────────────────────

    async def tool_node(state: AgentState) -> dict:
        """Execute tools and approve only exact, tool-attributed mutations.

        Extension point: lifecycle hooks (PreToolUse/PostToolUse) attach here.
        Extension point: MCP tool providers can be merged into ``_tools_by_name``.
        """
        messages = state["messages"]
        last_ai = messages[-1]

        results: list[ToolMessage] = []
        for tc in last_ai.tool_calls:
            tool_name = tc["name"]
            tool_args = dict(tc.get("args", {}))
            tool_id = tc["id"]

            pre = run_hook(
                "PreToolUse",
                {"tool_name": tool_name, "tool_input": tool_args},
                personal_dir=personal_dir,
                server_mode=server_mode,
                enabled=hooks_enabled,
            )
            if pre.blocked:
                results.append(ToolMessage(
                    content=f"[BLOCKED BY HOOK] {pre.message}",
                    name=tool_name,
                    tool_call_id=tool_id,
                ))
                continue
            if pre.mutated_input is not None:
                tool_args = pre.mutated_input

            tool_fn = _tools_by_name.get(tool_name)
            if tool_fn is None:
                results.append(ToolMessage(
                    content=f"[Unknown tool: {tool_name}]",
                    name=tool_name,
                    tool_call_id=tool_id,
                ))
                continue

            artifacts: list[dict] = []
            if tool_name == "apply_patch":
                root = Path(data_dir or cwd or ".").resolve()
                patch_text = str(tool_args.get("patch") or tool_args.get("input") or "")
                try:
                    file_patches = parse_patch(patch_text, root)
                except Exception as exc:
                    output = f"[Patch preparation failed: {exc}]"
                else:
                    diffs: list[FileDiff] = []
                    pending: list[tuple[Path, bytes | None, bytes]] = []
                    for fp in file_patches:
                        target = Path(fp.path)
                        old = target.read_bytes() if target.exists() else None
                        if fp.new_content == b"" and target.exists():
                            diffs.append(exact_file_diff(target, root, old, None))
                            pending.append((target, old, b""))
                        else:
                            diffs.append(exact_file_diff(target, root, old, fp.new_content))
                            pending.append((target, old, fp.new_content))
                    if agent_config.disable_write_tools:
                        output = "[WRITE FAILED / ACCESS DENIED] Write operations are disabled."
                    else:
                        action, feedback = (
                            await approval_callback(tool_name, diffs, tool_args)
                            if approval_callback else ("yes", "")
                        )
                        if action in {"no", "suggest"}:
                            output = (
                                f"[PATCH NOT APPLIED] User feedback: {feedback}"
                                if action == "suggest" else
                                "[PATCH NOT APPLIED] The user rejected this change."
                            )
                        else:
                            applied = 0
                            for target, old, proposed in pending:
                                if content_hash(target.read_bytes() if target.exists() else None) != content_hash(old):
                                    output = "[WRITE CONFLICT] A file changed after approval was requested. No changes applied."
                                    break
                                if proposed == b"":
                                    if target.exists():
                                        target.unlink()
                                else:
                                    target.parent.mkdir(parents=True, exist_ok=True)
                                    target.write_bytes(proposed)
                                applied += 1
                                art = describe_artifact(target, root) if proposed else None
                                if art:
                                    artifacts.append(art)
                            else:
                                output = f"Applied patch to {applied} file(s)"
            elif tool_name in {"write_file", "write_binary_artifact"}:
                target = Path(str(tool_args.get("path", "")))
                if not target.is_absolute():
                    target = Path(data_dir or cwd or ".") / target
                target = target.resolve()
                root = Path(data_dir or cwd or ".").resolve()
                try:
                    target.relative_to(root)
                    old = target.read_bytes() if target.exists() else None
                    proposed = (
                        base64.b64decode(str(tool_args.get("content_base64", "")), validate=True)
                        if tool_name == "write_binary_artifact"
                        else str(tool_args.get("content", "")).encode("utf-8")
                    )
                    diff = exact_file_diff(target, root, old, proposed)
                except Exception as exc:
                    output = f"[Write preparation failed: {exc}]"
                else:
                    if agent_config.disable_write_tools:
                        output = "[WRITE FAILED / ACCESS DENIED] Write operations are disabled."
                    else:
                        action, feedback = (
                            await approval_callback(tool_name, [diff], tool_args)
                            if approval_callback else ("yes", "")
                        )
                        if action in {"no", "suggest"}:
                            output = (
                                f"[WRITE NOT APPLIED] User feedback: {feedback}"
                                if action == "suggest" else
                                "[WRITE NOT APPLIED] The user rejected this change."
                            )
                        elif content_hash(target.read_bytes() if target.exists() else None) != content_hash(old):
                            output = "[WRITE CONFLICT] The target changed after approval was requested. No change was applied."
                        else:
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(proposed)
                            output = f"Wrote {len(proposed)} bytes to {target}"
                            artifact = describe_artifact(target, root)
                            if artifact:
                                artifacts.append(artifact)
            else:
                if tool_name in _EXECUTION_TOOLS and execution_service is not None:
                    execution_service.set_active_tool_call_id(tool_id)
                try:
                    output = await tool_fn.ainvoke(tool_args)
                except TypeError:
                    output = tool_fn.invoke(tool_args)
                except Exception as exc:
                    output = f"[Tool error: {exc}]"
                if tool_name in _EXECUTION_TOOLS and execution_service is not None:
                    last = getattr(execution_service, "last_tool_result", None)
                    if last and last.artifacts:
                        artifacts.extend(last.artifacts)

            content = str(output) if output is not None else ""
            if len(content) > _MAX_TOOL_RESULT_CHARS:
                content = (
                    content[:_MAX_TOOL_RESULT_CHARS]
                    + f"\n\n… [output truncated at {_MAX_TOOL_RESULT_CHARS} chars — "
                    f"use .head()/.describe() for large DataFrames]"
                )

            run_hook(
                "PostToolUse",
                {"tool_name": tool_name, "tool_input": tool_args, "tool_output": content},
                personal_dir=personal_dir,
                server_mode=server_mode,
                enabled=hooks_enabled,
            )

            results.append(ToolMessage(
                content=content,
                name=tool_name,
                tool_call_id=tool_id,
                additional_kwargs={"artifacts": artifacts} if artifacts else {},
            ))

        return {"messages": results}

    def agent_node(state: AgentState) -> dict:
        """Call the LLM with the current messages (after optional compression)."""
        messages = list(state["messages"])
        iteration = state.get("iteration", 0)

        # ── Inject system prompt if not present ──────────────────────
        if not messages or not isinstance(messages[0], SystemMessage):
            messages.insert(0, SystemMessage(content=system_prompt))

        # ── Auto-compress if over threshold ──────────────────────────
        current_tokens = _count_tokens(model_name, messages)
        usage_ratio = current_tokens / context_window if context_window else 0
        if usage_ratio >= threshold:
            logger.info(
                "Context at %.0f%% (%d / %d tokens) — compressing",
                usage_ratio * 100, current_tokens, context_window,
            )
            run_hook(
                "PreCompact",
                {"token_count": current_tokens, "context_window": context_window},
                personal_dir=personal_dir,
                server_mode=server_mode,
                enabled=hooks_enabled,
            )
            messages = _compress_messages(messages, model_name, keep_recent, llm)

        # ── LLM call with error handling ────────────────────────────
        try:
            response = llm_with_tools.invoke(messages)
        except litellm.RateLimitError as exc:
            # Provider rate-limit (429 / TPM / RPM).  Raise a clean
            # exception — the UI layer decides how to present it.
            # The graph stops here; conversation history is NOT modified.
            _retry = _parse_retry_after(str(exc))
            raise ProviderRateLimitError(
                str(exc), retry_after=_retry,
            ) from exc
        except litellm.ContextWindowExceededError:
            # Genuine context overflow → compress and retry once.
            logger.warning("Context window exceeded — compressing and retrying")
            messages = _compress_messages(
                messages, model_name, keep_recent, llm,
            )
            try:
                response = llm_with_tools.invoke(messages)
            except litellm.ContextWindowExceededError:
                logger.warning("Context window exceeded even after compression — returning error message")
                response = AIMessage(content="I've exceeded my context limit even after compressing the conversation. Please start a new session.")
        except litellm.BadRequestError as exc:
            # Model produced a malformed tool call or hallucinated a tool
            # name.  Covers:
            #   - "tool_use_failed"  (model emitted text instead of a call)
            #   - "not in request.tools" (hallucinated tool name)
            #   - "Failed to parse tool call arguments as JSON"
            err_msg = str(exc)
            is_tool_error = (
                "tool_use_failed" in err_msg
                or "not in request.tools" in err_msg
                or "Failed to parse tool call" in err_msg
            )
            if is_tool_error:
                original_messages = list(messages)
                logger.warning(
                    "Model produced invalid tool call — retrying "
                    "(max %d retries): %s",
                    bad_req_retries, err_msg[:300],
                )
                tool_names_str = ", ".join(t.name for t in tools)
                # Retry loop: give the model `bad_req_retries` chances
                # to fix its malformed JSON, each time WITH tools bound
                # so it can continue analysis (not prematurely stop).
                response = None
                for attempt in range(1, bad_req_retries + 1):
                    hint = HumanMessage(
                        content=(
                            "[System] Your previous tool call was rejected "
                            "because the JSON arguments were malformed "
                            f"(attempt {attempt}/{bad_req_retries}).  "
                            "Please try the same operation again with "
                            "properly formatted JSON.  Make sure all string "
                            "arguments are valid JSON strings (escape "
                            "newlines as \\n, quotes as \\\").  "
                            f"Available tools: {tool_names_str}"
                        )
                    )
                    messages.append(hint)
                    try:
                        response = llm_with_tools.invoke(messages)
                        break  # success
                    except litellm.BadRequestError as retry_exc:
                        logger.warning(
                            "Tool call retry %d/%d failed: %s",
                            attempt, bad_req_retries, str(retry_exc)[:200],
                        )
                        err_msg = str(retry_exc)
                        continue

                if response is None:
                    logger.warning(
                        "Tool call failed %d times — retrying original "
                        "request without tools.", bad_req_retries,
                    )
                    response = llm.invoke(original_messages)
            else:
                raise

        # ── Intercept ask_human → convert to plain text response ─────
        # The model wants to ask the user a question.  Strip the tool
        # call and return the question as a regular AIMessage so the
        # graph terminates and the REPL shows it to the user.
        if response.tool_calls:
            for tc in response.tool_calls:
                if tc["name"] == "ask_human":
                    question = tc.get("args", {}).get("question", "")
                    logger.info("ask_human intercepted — pausing for user input.")
                    return {
                        "messages": [AIMessage(content=question)],
                        "iteration": iteration + 1,
                    }

        # ── Wrap-up nudge when approaching max iterations ────────────
        # When the agent is 2 iterations from the limit, inject a hint
        # so it wraps up on its own rather than being hard-stopped.
        if iteration >= max_iter - 2 and response.tool_calls:
            logger.info(
                "Approaching max iterations (%d/%d) — injecting wrap-up nudge.",
                iteration, max_iter,
            )
            nudge = SystemMessage(content=(
                "[System] You are approaching the tool-call limit.  "
                "Wrap up your analysis now and respond with your "
                "findings.  Do not call any more tools."
            ))
            # Re-invoke without tools bound so the model can only
            # produce text.
            messages.append(response)  # include its last thinking
            messages.append(nudge)
            response = llm.invoke(messages)

        return {"messages": [response], "iteration": iteration + 1}

    def should_continue(state: AgentState) -> Literal["tools", "__end__"]:
        """Route: tool_calls → tools, else → end.  Max iterations is the safety net."""
        messages = state["messages"]
        last = messages[-1]
        iteration = state.get("iteration", 0)

        # Hard stop — max iterations reached
        if iteration >= max_iter:
            logger.warning("Hit max iterations (%d) — stopping.", max_iter)
            return END  # type: ignore[return-value]

        # Normal routing: tool_calls → execute, else → done
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END  # type: ignore[return-value]

    # ── Wire the graph ───────────────────────────────────────────────

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")

    return graph.compile()
