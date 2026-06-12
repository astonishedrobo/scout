# Using Local LLMs with Scout

Scout routes all LLM calls through [LiteLLM](https://docs.litellm.ai/), which means any LiteLLM-compatible local provider works out of the box. This guide covers the two most common options: **Ollama** and **vLLM**.

---

## How model configuration works

Scout discovers available models from environment variables:

| Variable | Purpose |
|---|---|
| `{PROVIDER}_API_KEY` | API key for the provider (required, can be a dummy value for local servers) |
| `{PROVIDER}_API_BASE` | Custom endpoint URL |
| `{PROVIDER}_MODELS` | Comma-separated list of models to expose in the UI |
| `AGENT_MODEL` | Default model used when a session starts |

All `{PROVIDER}_MODELS` lists are merged into a single model picker in the UI, so users can switch between cloud and local models freely.

---

## Option 1: Ollama

[Ollama](https://ollama.com) is the easiest way to run models locally. It downloads and serves models (Llama, Mistral, Gemma, etc.) with a single command.

### docker-compose.yml

```yaml
services:
  ollama:
    image: ollama/ollama
    volumes:
      - ollama-data:/root/.ollama

  scout-server:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: scout-server
    restart: unless-stopped
    ports:
      - "4200:4200"
    volumes:
      - scout-data:/root/.config/scout
      - ./workspace:/app/workspace
      - ./skills:/app/workspace/.scout/skills:ro
    environment:
      - SCOUT_SECRET_KEY=${SCOUT_SECRET_KEY}
      # Ollama — no API key needed
      - OLLAMA_API_BASE=http://ollama:11434
      - OLLAMA_MODELS=ollama/llama3.2,ollama/mistral
      - AGENT_MODEL=${AGENT_MODEL:-ollama/llama3.2}
    depends_on:
      - ollama

volumes:
  scout-data:
  ollama-data:
```

### Pull a model after starting

```bash
docker compose up -d
docker exec ollama ollama pull llama3.2
```

Models must be pulled before they can be used. See [ollama.com/library](https://ollama.com/library) for available models.

---

## Option 2: vLLM

[vLLM](https://docs.vllm.ai) is a high-throughput inference server. It exposes an OpenAI-compatible API, so you use the `openai/` LiteLLM prefix but point it at your local server.

> **Note:** vLLM requires a CUDA-capable GPU in most configurations.

### docker-compose.yml

```yaml
services:
  vllm:
    image: vllm/vllm-openai:latest
    command: --model mistralai/Mistral-7B-Instruct-v0.2
    volumes:
      - vllm-models:/root/.cache/huggingface
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  scout-server:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: scout-server
    restart: unless-stopped
    ports:
      - "4200:4200"
    volumes:
      - scout-data:/root/.config/scout
      - ./workspace:/app/workspace
      - ./skills:/app/workspace/.scout/skills:ro
    environment:
      - SCOUT_SECRET_KEY=${SCOUT_SECRET_KEY}
      # vLLM — uses openai/ prefix with a custom api_base
      - VLLM_API_KEY=not-needed
      - VLLM_API_BASE=http://vllm:8000/v1
      - VLLM_MODELS=openai/mistralai/Mistral-7B-Instruct-v0.2
      - AGENT_MODEL=${AGENT_MODEL:-openai/mistralai/Mistral-7B-Instruct-v0.2}
    depends_on:
      - vllm

volumes:
  scout-data:
  vllm-models:
```

The model name in `VLLM_MODELS` must match exactly what vLLM was started with (the Hugging Face model ID passed to `--model`).

---

## Mixing local and cloud models

You can combine any number of providers. Users can then pick from all of them in the UI:

```yaml
environment:
  - OPENAI_API_KEY=${OPENAI_API_KEY}
  - OPENAI_MODELS=openai/gpt-4o,openai/gpt-4o-mini

  - OLLAMA_API_BASE=http://ollama:11434
  - OLLAMA_MODELS=ollama/llama3.2,ollama/mistral

  - AGENT_MODEL=${AGENT_MODEL:-openai/gpt-4o}  # cloud default, override to use local
```

---

## Comparison

| | Ollama | vLLM |
|---|---|---|
| LiteLLM prefix | `ollama/` | `openai/` |
| API key | not required | required (dummy value is fine) |
| GPU | optional | recommended |
| Model loading | `ollama pull <model>` after start | `--model` flag at startup |
| Best for | local dev, CPU-friendly models | production, high-throughput GPU inference |
