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
        "max_retries": 2,
    }


def test_agent_chat_model_allows_bounded_retry_override():
    with patch("langchain_litellm.ChatLiteLLM") as chat_model:
        _init_chat_model("openai/test", 0.2, max_retries=0)

    assert chat_model.call_args.kwargs["max_retries"] == 0
