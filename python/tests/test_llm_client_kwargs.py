from unittest.mock import patch

from scout.agent.graph import _init_chat_model


def test_agent_chat_model_passes_client_kwargs():
    with patch("langchain_litellm.ChatLiteLLM") as chat_model:
        _init_chat_model(
            "hosted_vllm/Qwen/Qwen3-0.6B",
            0.7,
            client_kwargs={
                "api_key": "local-vllm",
                "api_base": "http://vllm:8000/v1",
            },
        )

    assert chat_model.call_args.kwargs == {
        "model": "hosted_vllm/Qwen/Qwen3-0.6B",
        "temperature": 0.7,
        "api_key": "local-vllm",
        "api_base": "http://vllm:8000/v1",
    }
