# Configuration

This page explains where Scout settings live and how model configuration works. Follow [Local setup](local-setup.md) or [Server deployment](deployment.md) for the complete setup process, including which configuration files to edit before launching Scout.

## Where settings live

Scout combines settings from several places. Settings loaded later replace settings loaded earlier.

### Local, single-user launch

1. Scout's built-in defaults
2. `~/.config/scout/config.yaml`, if it exists
3. A YAML file passed with `--config`
4. Temporary settings chosen for the current session

For example:

```bash
node packages/scout/dist/index.js --gui --config ./my-scout.yaml
```

### Docker, multi-user deployment

1. Scout's built-in defaults
2. `config/scout.yaml`
3. secrets and environment variables from `.env`
4. preferences saved by each signed-in user
5. temporary settings chosen for the current session

Use each location for a different purpose:

| Location | Put this there |
| --- | --- |
| `config/scout.yaml` | Models, provider URLs, model capabilities, and administrator-controlled features |
| `.env` | API keys, passwords, signing secrets, and deployment-specific values |
| User settings page | Preferences that each user may change, such as whether to use or generate memories |

Do not commit a populated `.env` file.

## LangSmith tracing

Scout's LangGraph agent can send traces to LangSmith without additional code.
Tracing is disabled by default. For a local launch, export:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY="your-langsmith-api-key"
export LANGSMITH_PROJECT="scout"
```

For Docker, add the same values to `.env`, then recreate the server container:

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your-langsmith-api-key
LANGSMITH_PROJECT=scout
```

```bash
docker compose up -d --force-recreate scout-server
```

`LANGSMITH_ENDPOINT` defaults to the US endpoint. Set it for another LangSmith
region or a self-hosted deployment. Set `LANGSMITH_WORKSPACE_ID` only when the
API key can access multiple workspaces. Traces include Scout's user ID, session
ID, selected model, and local/server mode as searchable metadata. Disable tracing
at any time with `LANGSMITH_TRACING=false`.

## Understanding model names

Each configured model has three related names. They are easy to confuse:

| Name | Example | What it controls |
| --- | --- | --- |
| Provider label | `vllm` | Scout uses it to find `VLLM_API_KEY` and `VLLM_API_BASE` |
| Model ID | `hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2` | Tells Scout's model library how to contact and identify the model |
| Capability key | `hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2` | Tells Scout whether that exact model supports images |

The provider label and the model ID prefix do **not** always match. For example, the provider label is `vllm`, while the model ID starts with `hosted_vllm/`.

Scout uses [LiteLLM](https://docs.litellm.ai/) internally to connect to different model services through one interface. The prefix at the start of a model ID tells LiteLLM which kind of service to use:

| Service | Model ID example |
| --- | --- |
| OpenAI | `openai/gpt-5-mini` |
| Groq | `groq/llama-3.3-70b-versatile` |
| Ollama | `ollama/llama3.2` |
| vLLM server | `hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2` |

## Exact model matching

The model ID must be written exactly the same way in all three places where it appears:

```yaml
agent:
  model: hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2

llm:
  providers:
    vllm:
      models:
        - hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2

model_capabilities:
  hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2:
    vision: unsupported
```

In this example:

- `vllm` is the provider label. Scout looks for `VLLM_API_KEY` and `VLLM_API_BASE`.
- `hosted_vllm/...` is the model ID. It is repeated exactly under `agent`, `models`, and `model_capabilities`.
- The model does not accept images, so `vision` is set to `unsupported`.

## Configure a provider

Add a provider under `llm.providers`, then choose one of its model IDs under `agent.model`.

```yaml
agent:
  model: openai/gpt-5-mini
  provider_max_retries: 2

llm:
  providers:
    openai:
      models:
        - openai/gpt-5-mini
```

Set its API key outside the YAML:

```bash
export OPENAI_API_KEY="your-key"
```

`provider_max_retries` bounds automatic retries for transient connection, timeout, and provider 5xx failures. Rate-limit responses retain their explicit `Retry-After` handling instead of being retried indefinitely. Keep this value small to avoid multiplying latency or API usage during an outage.

For Docker, put the same value in `.env`:

```dotenv
OPENAI_API_KEY=your-key
```

The provider label determines the environment variable name. A provider labeled `openai` uses `OPENAI_API_KEY`; one labeled `groq` uses `GROQ_API_KEY`.

### Local services still need a key value

Scout currently lists a provider's models only when that provider has a non-empty API key. Services such as Ollama and a local vLLM server usually do not verify API keys, but Scout still needs a placeholder value:

```dotenv
OLLAMA_API_KEY=not-needed
VLLM_API_KEY=not-needed
```

These are placeholders, not real secrets. See [Local LLM setup](local-llm.md) for complete examples.

## Provider URLs

Use `api_base` when the model service is not available at its normal public URL:

```yaml
llm:
  providers:
    ollama:
      api_base: http://localhost:11434
      models:
        - ollama/llama3.2
```

You can also set the URL through an environment variable derived from the provider label:

```bash
export OLLAMA_API_BASE="http://localhost:11434"
```

For Docker, `localhost` means the Scout container itself, not your computer and not another container. Use the Docker service name instead, such as `http://ollama:11434`.

## Image support

Scout tries to discover whether a model accepts images. Some model services do not provide enough information, so Scout may report the capability as unknown and prevent images from being sent.

When you know the answer, add an explicit capability:

```yaml
model_capabilities:
  openai/gpt-5-mini:
    vision: supported

  hosted_vllm/mistralai/Mistral-7B-Instruct-v0.2:
    vision: unsupported
```

The capability key must exactly match the configured model ID. Only set `vision: supported` after confirming that the model and the service hosting it both accept images.

## Conversation titles

Scout generates a short title in the background after the first message. By default it uses the conversation model and waits up to 60 seconds. A slow or unavailable model does not delay the conversation; Scout uses a short title based on the first message if generation fails.

Administrators can change this behavior in YAML:

```yaml
session_titles:
  enabled: true
  timeout_seconds: 60
  max_attempts: 2
  model: openai/gpt-5-mini
```

Omit `model` to use each conversation's selected model. The configured title model must be available through one of the configured providers. Title generation runs after the first response is available, including for image-only and file-only prompts. If every model attempt fails, Scout creates a title from the saved conversation content.

## Multi-user resource limits

Docker deployments default to a persistent SQLite FTS5 lexical index, keeping the full inverted index on disk instead of resident Python memory. Unchanged indexes are reused across sessions and restarts. CSV tables are queried directly rather than duplicated into FTS. BM25 remains available as a deployment fallback. The backend is not exposed as an agent tool parameter.

```yaml
retriever:
  backend: sqlite_fts5  # sqlite_fts5 (default) or bm25
  max_index_bytes: 25000000
  max_chunks: 20000
  max_resident_users: 4
  idle_ttl_seconds: 900
  build_concurrency: 1

server:
  max_live_sessions: 64
  max_live_sessions_per_user: 8
  max_concurrent_requests: 8
  max_queued_requests: 256
  max_queued_requests_per_user: 16
  request_queue_timeout_seconds: 60
  priority_aging_seconds: 15
  default_priority_group: standard
  priority_groups:
    standard: {priority: 0, max_concurrent_requests_per_user: 4}
    priority: {priority: 1, max_concurrent_requests_per_user: 6}
    critical: {priority: 2, max_concurrent_requests_per_user: 8}
  session_idle_ttl_seconds: 1800
  session_eviction_grace_seconds: 5
  agent_init_concurrency: 2
  agent_init_timeout_seconds: 45
  maintenance_interval_seconds: 60
```

`max_index_bytes` and `max_chunks` apply to the legacy in-memory BM25 backend. `max_resident_users` bounds resident retriever objects, while persistent FTS5 data lives under each user's internal `.scout-cache`. `build_concurrency` prevents simultaneous PDF parsing/index construction from causing spikes. `max_live_sessions` bounds resident conversation agents, while `max_live_sessions_per_user` prevents one account from monopolising that cache.

Agent turns are independently controlled by a work-conserving admission queue. At most `max_concurrent_requests` turns run at once. Standard users can run four simultaneous turns; admins can assign another capacity group from the Users panel. Higher `priority` values receive bounded queue preference, and `priority_aging_seconds` steadily raises older requests so lower-priority groups cannot starve. Capacity is never reserved: any eligible user can consume an idle global slot. A full waiting room or a request that waits longer than `request_queue_timeout_seconds` receives `503` with `Retry-After` and a user-facing capacity message.

`session_eviction_grace_seconds` prevents a just-used non-streaming session from being closed underneath its request. Live sessions, initializing sessions, active turns, queued turns, queue age, and configured limits are reported under `resources` in `/health`. Admission accounting is process-local; multi-process or multi-replica deployments require a shared scheduler before increasing the replica count.

## Apply configuration changes

For a local launch, stop and restart Scout after changing YAML or environment variables.

For Docker:

- After changing `.env`, recreate the containers with `docker compose up --build -d`.
- After changing `config/scout.yaml`, open **Admin → Config** and reload the configuration, or restart the containers.
- Configuration changes apply to new conversations. Existing conversations keep the settings they started with.

## Validate your setup

After launching Scout:

1. Open the model selector and confirm that your model appears.
2. Start a new conversation and send a short text message.
3. If you configured image support, start another new conversation and test an image.

If the model is missing, check that its provider has a non-empty API key value and that the same model ID is used everywhere.
