from pathlib import Path

import pytest

from scout.config import AppConfig, config_hash, load_deployment_config, redacted_config
from scout.secrets import load_secret, require_production_secret


def test_deployment_config_is_strict_and_hashes(tmp_path: Path):
    path = tmp_path / "scout.yaml"
    path.write_text("agent:\n  model: test/model\nmemories:\n  use_memories: false\n", encoding="utf-8")
    config = load_deployment_config(path)
    assert config.agent.model == "test/model"
    assert config.memories.use_memories is False
    assert config_hash(config) == config_hash(config.model_copy(deep=True))

    path.write_text("unknown_section:\n  enabled: true\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Unknown deployment config"):
        load_deployment_config(path)


def test_deployment_config_accepts_model_capabilities(tmp_path: Path):
    path = tmp_path / "scout.yaml"
    path.write_text(
        "model_capabilities:\n"
        "  hosted_vllm/Qwen/Qwen3-0.6B:\n"
        "    vision: unsupported\n",
        encoding="utf-8",
    )

    config = load_deployment_config(path)

    assert config.model_capabilities == {
        "hosted_vllm/Qwen/Qwen3-0.6B": {"vision": "unsupported"}
    }


def test_per_user_session_limit_cannot_exceed_global_limit():
    config = AppConfig(server={"max_live_sessions": 64, "max_live_sessions_per_user": 8})
    assert config.server.max_live_sessions == 64
    assert config.server.max_live_sessions_per_user == 8

    with pytest.raises(ValueError, match="max_live_sessions_per_user"):
        AppConfig(server={"max_live_sessions": 4, "max_live_sessions_per_user": 5})


def test_default_admission_groups_limit_standard_users_to_four():
    server = AppConfig().server
    assert server.max_concurrent_requests == 8
    assert server.priority_groups["standard"].max_concurrent_requests_per_user == 4
    assert server.priority_groups["priority"].max_concurrent_requests_per_user == 6
    assert server.priority_groups["critical"].max_concurrent_requests_per_user == 8


def test_retrieval_backend_is_deployment_configuration():
    assert AppConfig().retriever.backend == "sqlite_fts5"
    assert AppConfig(retriever={"backend": "bm25"}).retriever.backend == "bm25"

    with pytest.raises(ValueError, match="cannot exceed max_concurrent_requests"):
        AppConfig(server={
            "max_concurrent_requests": 4,
            "priority_groups": {
                "standard": {"priority": 0, "max_concurrent_requests_per_user": 5}
            },
        })


def test_model_client_kwargs_use_provider_env(monkeypatch):
    monkeypatch.setenv("VLLM_API_KEY", "local-vllm")
    monkeypatch.setenv("VLLM_API_BASE", "http://vllm:8000/v1")
    config = AppConfig(
        llm={
            "providers": {
                "vllm": {"models": ["hosted_vllm/Qwen/Qwen3-0.6B"]}
            }
        }
    )

    assert config.llm.get_model_client_kwargs("hosted_vllm/Qwen/Qwen3-0.6B") == {
        "api_key": "local-vllm",
        "api_base": "http://vllm:8000/v1",
    }


def test_model_client_kwargs_match_env_models(monkeypatch):
    monkeypatch.setenv("VLLM_API_KEY", "local-vllm")
    monkeypatch.setenv("VLLM_API_BASE", "http://vllm:8000/v1")
    monkeypatch.setenv("VLLM_MODELS", "hosted_vllm/Qwen/Qwen3-0.6B")
    config = AppConfig()

    assert config.llm.get_model_client_kwargs("hosted_vllm/Qwen/Qwen3-0.6B") == {
        "api_key": "local-vllm",
        "api_base": "http://vllm:8000/v1",
    }


def test_redacted_config_hides_provider_keys():
    config = AppConfig(llm={"providers": {"openai": {"api_key": "secret", "models": ["openai/x"]}}})
    assert redacted_config(config)["llm"]["providers"]["openai"]["api_key"] == "[REDACTED]"


def test_secret_file_precedes_environment(tmp_path: Path, monkeypatch):
    secret_file = tmp_path / "secret"
    secret_file.write_text("from-file\n", encoding="utf-8")
    monkeypatch.setenv("TEST_SECRET", "from-env")
    monkeypatch.setenv("TEST_SECRET_FILE", str(secret_file))
    assert load_secret("TEST_SECRET") == "from-file"


def test_production_secret_rejects_insecure_default(monkeypatch):
    monkeypatch.setenv("SCOUT_ENV", "production")
    monkeypatch.setenv("TEST_SECRET", "insecure")
    with pytest.raises(RuntimeError, match="securely configured"):
        require_production_secret("TEST_SECRET", {"insecure"})
