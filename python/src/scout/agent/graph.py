"""LangGraph ReAct graph with auto-context compression.

Builds a ``StateGraph`` that alternates between the LLM (agent node)
and tool execution, with a compression step that fires when token
usage exceeds a configurable fraction of the model's context window.

Part of the Scout agent framework.
"""

from __future__ import annotations

import logging
import base64
import uuid
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
from ..artifacts import describe_artifact, html_artifact_warning
from ..path_display import redact_paths, sanitize_artifacts
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
_MAX_CHANGE_BYTES = 2_000_000

logger = logging.getLogger(__name__)


def _normalize_user_input_options(raw_options: object) -> list[dict[str, str]]:
    if not isinstance(raw_options, list):
        return []
    options: list[dict[str, str]] = []
    for item in raw_options[:5]:
        if isinstance(item, str):
            label = item.strip()
            description = ""
        elif isinstance(item, dict):
            label = str(item.get("label") or item.get("title") or "").strip()
            description = str(item.get("description") or item.get("desc") or "").strip()
        else:
            continue
        if not label:
            continue
        options.append({"label": label[:80], "description": description[:160]})
    return options


def _build_user_input_request(tool_call: dict) -> AIMessage:
    args = tool_call.get("args", {}) or {}
    question = str(args.get("question") or "").strip()
    header = str(args.get("header") or "Question").strip() or "Question"
    request = {
        "type": "user_input_request",
        "request_id": tool_call.get("id", ""),
        "questions": [
            {
                "id": "question",
                "header": header[:40],
                "question": question,
                "options": _normalize_user_input_options(args.get("options")),
                "is_other": True,
            }
        ],
    }
    return AIMessage(
        content=question,
        additional_kwargs={"user_input_request": request},
    )


def _change_hash(content: bytes | None) -> str | None:
    return None if content is None else content_hash(content)


def _change_content_b64(content: bytes | None) -> str | None:
    if content is None or len(content) > _MAX_CHANGE_BYTES:
        return None
    return base64.b64encode(content).decode("ascii")


def _summarize_file_changes(diffs: list[FileDiff]) -> str:
    if len(diffs) == 1:
        d = diffs[0]
        verb = {"added": "Created", "modified": "Edited", "deleted": "Deleted"}.get(d.status, "Changed")
        return f"{verb} {d.path}"
    return f"Edited {len(diffs)} files"


def _file_change_sets(tool_name: str, diffs: list[FileDiff], summary: str = "") -> list[dict]:
    if not diffs:
        return []
    entries = []
    for d in diffs:
        old_b64 = _change_content_b64(d.old_bytes)
        new_b64 = _change_content_b64(d.new_bytes)
        reversible = (
            (d.old_bytes is None or old_b64 is not None)
            and (d.new_bytes is None or new_b64 is not None)
        )
        entries.append({
            "path": d.path,
            "status": d.status,
            "diff": d.diff,
            "old_hash": _change_hash(d.old_bytes),
            "new_hash": _change_hash(d.new_bytes),
            "old_content_base64": old_b64,
            "new_content_base64": new_b64,
            "reversible": reversible,
        })
    return [{
        "id": str(uuid.uuid4()),
        "tool_name": tool_name,
        "summary": summary or _summarize_file_changes(diffs),
        "created_at": "",
        "entries": entries,
    }]


def _init_chat_model(
    model: str,
    temperature: float,
    *,
    client_kwargs: dict[str, str] | None = None,
) -> BaseChatModel:
    """Initialise a LangChain chat model from a LiteLLM-style model string.

    Uses ``ChatLiteLLM`` which is provider-agnostic — it accepts any
    model string that LiteLLM supports (e.g. ``groq/llama-3.1-8b-instant``,
    ``openai/gpt-4o``, ``anthropic/claude-3.5-sonnet``).
    """
    from langchain_litellm import ChatLiteLLM
    return ChatLiteLLM(model=model, temperature=temperature, **(client_kwargs or {}))

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


def _unresolved_tool_call_ids(messages: list) -> list[str]:
    """Return tool-call IDs that have not received a matching ToolMessage."""
    unresolved: dict[str, None] = {}
    for message in messages:
        if isinstance(message, AIMessage):
            for tool_call in message.tool_calls:
                unresolved[tool_call["id"]] = None
        elif isinstance(message, ToolMessage):
            unresolved.pop(message.tool_call_id, None)
    return list(unresolved)


def _assert_tool_history_complete(messages: list) -> None:
    unresolved = _unresolved_tool_call_ids(messages)
    if unresolved:
        raise RuntimeError(
            "Refusing provider call with unresolved tool calls: "
            + ", ".join(unresolved)
        )


def _safe_recent_split(messages: list, split: int, start_idx: int = 0) -> int:
    """Move a compression split left so it never separates a tool exchange."""
    if split >= len(messages) or not isinstance(messages[split], ToolMessage):
        return split
    cursor = split - 1
    while cursor >= start_idx and isinstance(messages[cursor], ToolMessage):
        cursor -= 1
    if cursor >= start_idx and isinstance(messages[cursor], AIMessage) and messages[cursor].tool_calls:
        return cursor
    return split


def _route_after_agent(state: AgentState) -> Literal["tools", "__end__"]:
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "tools"
    return END  # type: ignore[return-value]


def _route_after_tools(state: AgentState, max_iterations: int) -> Literal["agent", "wrap_up"]:
    if _unresolved_tool_call_ids(state["messages"]):
        raise RuntimeError("Tool node returned without resolving every tool call.")
    if state.get("iteration", 0) >= max_iterations - 1:
        return "wrap_up"
    return "agent"


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
    split = _safe_recent_split(messages, split, start_idx)
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
    llm_client_kwargs: dict[str, str] | None = None,
    personal_dir: str | None = None,
    shared_dir: str | None = None,
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

    llm = _init_chat_model(
        model_name,
        agent_config.temperature,
        client_kwargs=llm_client_kwargs,
    )
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
            file_changes: list[dict] = []
            if tool_name == "apply_patch":
                root = Path(data_dir or cwd or ".").resolve()
                patch_text = str(tool_args.get("patch") or tool_args.get("input") or "")
                try:
                    file_patches = parse_patch(patch_text, root)
                except Exception as exc:
                    output = f"[Patch preparation failed: {exc}]"
                else:
                    diffs: list[FileDiff] = []
                    pending: list[tuple[Path, bytes | None, bytes | None]] = []
                    for fp in file_patches:
                        target = Path(fp.path)
                        old = target.read_bytes() if target.exists() else None
                        if fp.delete:
                            diffs.append(exact_file_diff(target, root, old, None))
                            pending.append((target, old, None))
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
                                if proposed is None:
                                    if target.exists():
                                        target.unlink()
                                else:
                                    target.parent.mkdir(parents=True, exist_ok=True)
                                    target.write_bytes(proposed)
                                applied += 1
                                art = describe_artifact(target, root) if proposed is not None else None
                                if art:
                                    artifacts.append(art)
                            else:
                                output = f"Applied patch to {applied} file(s)"
                                file_changes = _file_change_sets(tool_name, diffs)
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
                    if tool_name == "write_binary_artifact":
                        output += (
                            " Do not retry by printing or reconstructing base64. "
                            "Generate and save the binary directly from a terminal script or run_node."
                        )
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
                            warning = html_artifact_warning(target)
                            if warning:
                                output += f"\n{warning}"
                            artifact = describe_artifact(target, root)
                            if artifact:
                                artifacts.append(artifact)
                            file_changes = _file_change_sets(tool_name, [diff])
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
                    if last and getattr(last, "promotion_diffs", None):
                        file_changes = _file_change_sets(tool_name, last.promotion_diffs)

            content = str(output) if output is not None else ""
            content = redact_paths(content, data_dir or cwd or ".", shared_dir)
            artifacts = sanitize_artifacts(artifacts, data_dir or cwd or ".", shared_dir)
            for change_set in file_changes:
                change_set["created_at"] = ""
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

            extra = {}
            if artifacts:
                extra["artifacts"] = artifacts
            if file_changes:
                extra["file_changes"] = file_changes
            results.append(ToolMessage(
                content=content,
                name=tool_name,
                tool_call_id=tool_id,
                additional_kwargs=extra,
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
            _assert_tool_history_complete(messages)
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

        # ── Intercept ask_user_choice → structured user input request ─────
        # Option B: pause this turn and let the UI send the answer as the
        # next normal user turn. This avoids LangGraph checkpoint/resume
        # plumbing while still preserving a structured MCQ/freeform UI.
        if response.tool_calls:
            for tc in response.tool_calls:
                if tc["name"] == "ask_user_choice":
                    logger.info("ask_user_choice intercepted — requesting structured user input.")
                    return {
                        "messages": [_build_user_input_request(tc)],
                        "iteration": iteration + 1,
                    }

        if not response.tool_calls and response.content:
            response = AIMessage(
                content=redact_paths(str(response.content), data_dir or cwd or ".", shared_dir),
                additional_kwargs=response.additional_kwargs,
                response_metadata=response.response_metadata,
                id=response.id,
                usage_metadata=response.usage_metadata,
            )

        return {"messages": [response], "iteration": iteration + 1}

    def wrap_up_node(state: AgentState) -> dict:
        """Produce a final tool-free response after all pending tools complete."""
        messages = list(state["messages"])
        if not messages or not isinstance(messages[0], SystemMessage):
            messages.insert(0, SystemMessage(content=system_prompt))
        _assert_tool_history_complete(messages)
        messages.append(SystemMessage(content=(
            "[System] You have reached the tool-call limit. Summarize the work "
            "completed, report any failures honestly, and respond without calling tools."
        )))
        logger.info("Tool-call limit reached — producing protocol-safe wrap-up.")
        response = llm.invoke(messages)
        if response.tool_calls:
            logger.warning("Tool-free wrap-up returned tool calls; stripping them.")
            content = response.content or (
                "I reached the tool-call limit before I could complete the task."
            )
            response = AIMessage(content=content)
        elif response.content:
            response = AIMessage(
                content=redact_paths(str(response.content), data_dir or cwd or ".", shared_dir),
                additional_kwargs=response.additional_kwargs,
                response_metadata=response.response_metadata,
                id=response.id,
                usage_metadata=response.usage_metadata,
            )
        return {"messages": [response]}

    def should_continue(state: AgentState) -> Literal["tools", "__end__"]:
        """Always execute pending calls; otherwise finish."""
        return _route_after_agent(state)

    def after_tools(state: AgentState) -> Literal["agent", "wrap_up"]:
        """Wrap up only after every call in the latest assistant message has a result."""
        return _route_after_tools(state, max_iter)

    # ── Wire the graph ───────────────────────────────────────────────

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_node("wrap_up", wrap_up_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_conditional_edges("tools", after_tools, {"agent": "agent", "wrap_up": "wrap_up"})
    graph.add_edge("wrap_up", END)

    return graph.compile()
