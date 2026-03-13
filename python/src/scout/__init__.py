"""Scout -- a generic data research agent framework.

Usage::

    from scout.agent import ScoutAgent

    async with ScoutAgent(project_dir=".") as agent:
        reply = await agent.chat("Tell me about this dataset")
        print(reply)
"""

__version__ = "0.1.0"
