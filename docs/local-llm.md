# Local LLM Setup

Scout can use a model running on your computer or on another machine you control. This page shows complete Ollama and vLLM examples.

Before continuing, choose how Scout itself will run:

- For one user on one computer, follow [Local setup](local-setup.md).
- For multiple users, follow [Server deployment](deployment.md). Multi-user Scout must run with Docker.

## How the connection works

Scout needs four pieces of information:

1. A **provider label**, such as `ollama` or `vllm`. Scout uses this label to find environment variables.
2. An **API base URL**, which is the address of the running model service.
3. A **model ID**, such as `ollama/llama3.2`. Its prefix tells Scout how to connect.
4. An optional **capability entry** that says whether the exact model ID accepts images.

The model ID must match exactly under `agent.model`, the provider's `models` list, and `model_capabilities`.

## Ollama: local Scout launch

Install Ollama, start it, and download a model:

```bash
ollama serve
ollama pull llama3.2
```

In another terminal, set a placeholder API key. Ollama does not normally verify it, but Scout needs a non-empty value before it will list the provider's models:

```bash
export OLLAMA_API_KEY=not-needed
```

Create a configuration file, for example `ollama-scout.yaml`:

```yaml
agent:
  model: ollama/llama3.2

llm:
  providers:
    ollama:
      api_base: http://localhost:11434
      models:
        - ollama/llama3.2

model_capabilities:
  ollama/llama3.2:
    vision: unsupported
```

Launch Scout with that file:

```bash
node packages/scout/dist/index.js --gui --config ./ollama-scout.yaml
```

Here, `ollama` is both the provider label and the model ID prefix. The model downloaded by Ollama is named `llama3.2`, while Scout refers to it as `ollama/llama3.2`.

## Ollama: Docker multi-user deployment

Add the placeholder key to `.env`:

```dotenv
OLLAMA_API_KEY=not-needed
```

Add an Ollama service to `docker-compose.yml`:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama-data:/root/.ollama

volumes:
  ollama-data:
```

Configure Scout in `config/scout.yaml`:

```yaml
agent:
  model: ollama/llama3.2

llm:
  providers:
    ollama:
      api_base: http://ollama:11434
      models:
        - ollama/llama3.2

model_capabilities:
  ollama/llama3.2:
    vision: unsupported
```

Start the services and download the model into the Ollama container:

```bash
docker compose up --build -d
docker compose exec ollama ollama pull llama3.2
```

The URL uses `ollama`, the Docker service name. Do not use `localhost` here because `localhost` inside the Scout container refers to Scout itself.

## vLLM: Docker multi-user deployment

Scout can launch and manage vLLM as part of the same Compose application. The
user does not need to create a separate vLLM instance. This example serves
`Qwen/Qwen3-0.6B`.

`scout deploy` adds this service to the deployment's `docker-compose.yml` when
vLLM is selected. Use the following only when configuring vLLM manually:

```yaml
services:
  vllm:
    image: vllm/vllm-openai:latest
    container_name: scout-vllm
    restart: unless-stopped
    gpus: all
    ipc: host
    volumes:
      - vllm-cache:/root/.cache/huggingface
    command:
      - --model
      - Qwen/Qwen3-0.6B
      - --served-model-name
      - Qwen/Qwen3-0.6B
      - --enable-auto-tool-choice
      - --tool-call-parser
      - hermes
      - --reasoning-parser
      - qwen3
    networks:
      - default

  scout-server:
    depends_on:
      - vllm
    environment:
      - VLLM_API_KEY=${VLLM_API_KEY:-local-vllm}
      - VLLM_API_BASE=${VLLM_API_BASE:-http://vllm:8000/v1}

volumes:
  vllm-cache:
```

The host must have an NVIDIA GPU, NVIDIA drivers, and NVIDIA Container Toolkit.
The cache volume keeps the downloaded model across container replacements.

Configure Scout in `config/scout.yaml`:

```yaml
agent:
  model: hosted_vllm/Qwen/Qwen3-0.6B

llm:
  providers:
    vllm:
      models:
        - hosted_vllm/Qwen/Qwen3-0.6B

model_capabilities:
  hosted_vllm/Qwen/Qwen3-0.6B:
    vision: unsupported
```

The names differ for a reason:

- `vllm` is the provider label, so Scout reads `VLLM_API_KEY` and `VLLM_API_BASE`.
- `Qwen/Qwen3-0.6B` is the name served by vLLM.
- `hosted_vllm/Qwen/Qwen3-0.6B` tells LiteLLM to use a hosted vLLM endpoint.
- The non-empty placeholder key makes the model visible in Scout's model picker.

Start the application:

```bash
docker compose up -d --build
```

The first start downloads the model and can take several minutes. Verify vLLM
from inside the Scout container, then verify Scout's model catalog:

```bash
docker compose exec scout-server curl http://vllm:8000/v1/models
curl http://localhost:4200/config/models
```

The second response should include `hosted_vllm/Qwen/Qwen3-0.6B`.

## Models that accept images

Do not assume a model accepts images because another version from the same family does. Confirm support in the model's documentation and with the server that hosts it.

Then mark the exact Scout model ID:

```yaml
model_capabilities:
  ollama/llava:
    vision: supported
```

If support is unknown, omit the entry. Scout will try to detect support and will prevent image use when it cannot verify that sending images is safe.

## Troubleshooting

### The model does not appear

Check all of the following:

- The provider has a non-empty API key. Use `not-needed` for a local service that does not verify keys.
- The model ID in `agent.model` exactly matches an entry in the provider's `models` list.
- The model service is running.
- The API base URL is reachable from where Scout runs.

### Scout cannot connect

- A local Scout launch normally reaches a local model service through `localhost`.
- A Docker Scout deployment must use a Docker service name or a network address reachable from the container.
- Include `/v1` in the vLLM URL when its OpenAI-compatible endpoint expects it.
- If a `hosted_vllm/...` request goes to `https://api.openai.com/chat/completions`, Scout did not pass the vLLM API base to LiteLLM. Check that `VLLM_API_BASE` is set for `scout-server` or set `api_base` under the `vllm` provider.

### Images are unavailable

Make sure the capability key exactly matches the configured model ID and that `vision` is set to `supported`. Start a new conversation after changing capabilities.

For the full explanation of provider labels, environment variables, and model IDs, read [Configuration](configuration.md).
