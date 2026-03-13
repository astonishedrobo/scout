"""LangGraph state definition for the Scout agent."""

from __future__ import annotations

from typing import Annotated

from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class AgentState(TypedDict):
    """Conversation state carried through the graph.

    ``messages`` uses the LangGraph ``add_messages`` reducer so that
    new messages are appended automatically.

    ``iteration`` is bumped on every agent → tools round-trip and is used
    for the max-iterations guard.
    """

    messages: Annotated[list, add_messages]
    iteration: int
