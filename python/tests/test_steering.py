from collections import deque
import threading

import pytest
from langchain_core.messages import AIMessage, HumanMessage

import scout.agent.graph as graph_module
from scout.agent import ScoutAgent
from scout.config import AgentConfig


class FakeModel:
    def bind_tools(self, _tools):
        return self

    def with_config(self, **_kwargs):
        return self

    def invoke(self, messages):
        user_text = "|".join(
            str(message.content)
            for message in messages
            if isinstance(message, HumanMessage)
        )
        return AIMessage(content=f"saw:{user_text}")


def bare_agent() -> ScoutAgent:
    agent = ScoutAgent.__new__(ScoutAgent)
    agent._pending_steers = deque()
    agent._inflight_steers = {}
    agent._steer_lock = threading.Lock()
    return agent


def test_steer_queue_is_fifo_idempotent_and_cancellable():
    agent = bare_agent()

    assert agent.enqueue_steer("one", "first", client_id="client-one")
    assert not agent.enqueue_steer("duplicate", "ignored", client_id="client-one")
    assert agent.enqueue_steer("two", "second", client_id="client-two")
    assert agent.cancel_steer("two")

    drained = agent._drain_steers()

    assert [message.content for message in drained] == ["first"]
    assert drained[0].additional_kwargs["scout_steer_id"] == "one"
    assert agent.pending_steers() == []


@pytest.mark.asyncio
async def test_graph_drains_steer_before_next_model_boundary(monkeypatch, tmp_path):
    model = FakeModel()
    monkeypatch.setattr(graph_module, "_init_chat_model", lambda *_args, **_kwargs: model)
    pending = [
        HumanMessage(
            content="change direction",
            additional_kwargs={"scout_steer_id": "steer-one"},
        ),
    ]
    def drain():
        drained = list(pending)
        pending.clear()
        return drained

    graph = graph_module.build_graph(
        AgentConfig(model="openai/gpt-4o-mini", max_iterations=2),
        [],
        system_prompt="test",
        cwd=str(tmp_path),
        data_dir=str(tmp_path),
        drain_steers=drain,
    )

    update = await graph.nodes["agent"].ainvoke({  # type: ignore[index]
        "messages": [HumanMessage(content="original")],
        "iteration": 0,
    })

    assert isinstance(update["messages"][0], HumanMessage)
    assert update["messages"][0].content == "change direction"
    assert update["messages"][1].content == "saw:original|change direction"
