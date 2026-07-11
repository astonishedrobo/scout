import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph.message import add_messages

import scout.agent.graph as graph_module
from scout.agent import _apply_message_delta
from scout.config import AgentConfig


class FakeModel:
    def __init__(self):
        self.compressions = 0
        self.model_calls = 0

    def bind_tools(self, _tools):
        return self

    def invoke(self, messages):
        first = messages[0] if messages else None
        if isinstance(first, SystemMessage) and "conversation compressor" in str(first.content).lower():
            self.compressions += 1
            return AIMessage(content="Stable summary with key findings.")
        self.model_calls += 1
        return AIMessage(content="done")


@pytest.mark.asyncio
async def test_compaction_replaces_prefix_and_is_reused_on_next_model_call(monkeypatch, tmp_path):
    model = FakeModel()
    monkeypatch.setattr(graph_module, "_init_chat_model", lambda *_args, **_kwargs: model)
    graph = graph_module.build_graph(
        AgentConfig(
            model="openai/gpt-4o-mini",
            context_compress_threshold=0.000001,
            compress_keep_recent=2,
            max_iterations=2,
        ),
        [],
        system_prompt="CURRENT SYSTEM PROMPT",
        cwd=str(tmp_path),
        data_dir=str(tmp_path),
    )
    original = add_messages([], [
        HumanMessage(content="old user finding " * 100),
        AIMessage(content="old answer " * 100),
        HumanMessage(content="recent question"),
        AIMessage(
            content="",
            tool_calls=[{"name": "read_file", "args": {"path": "x"}, "id": "call-1", "type": "tool_call"}],
        ),
        ToolMessage(content="recent result", name="read_file", tool_call_id="call-1"),
    ])

    first_update = await graph.nodes["agent"].ainvoke({"messages": original, "iteration": 0})  # type: ignore[index]
    compacted = add_messages(original, first_update["messages"])

    assert model.compressions == 1
    assert any(
        isinstance(message, SystemMessage)
        and message.additional_kwargs.get("scout_context_summary")
        for message in compacted
    )
    assert not any(message.content == original[0].content for message in compacted)
    assert any(isinstance(message, ToolMessage) and message.tool_call_id == "call-1" for message in compacted)

    await graph.nodes["agent"].ainvoke({"messages": compacted, "iteration": 1})  # type: ignore[index]

    assert model.compressions == 1
    assert model.model_calls == 2


def test_streamed_replacement_delta_updates_persistent_history():
    old = [HumanMessage(content="old", id="old-1"), AIMessage(content="keep", id="keep-1")]
    summary = SystemMessage(
        content="[Conversation summary]\nsummary",
        additional_kwargs={"scout_context_summary": True},
    )

    updated = _apply_message_delta(old, [summary], {"old-1"})

    assert [message.content for message in updated] == ["keep", summary.content]
