# Docker Multi-User Deployment

Use this setup when several people need separate Scout accounts and workspaces. Docker Compose is the only supported multi-user deployment method.

Docker runs Scout and its code-execution service in separate containers. This prevents model-generated code from running directly inside the main Scout server.

## Prerequisites

- Docker Engine
- Docker Compose
- Permission to access the Docker socket
- An API key for a model provider, or a model service reachable from Docker

## Files you will edit

| File | Purpose |
| --- | --- |
| `.env` | API keys, passwords, and private deployment values |
| `config/scout.yaml` | Available models, default model, model capabilities, and administrator-controlled behavior |
| `docker-compose.yml` | The containers, networks, ports, and storage used by the deployment |

Most deployments only need to edit `.env` and `config/scout.yaml`.

## 1. Configure private values

Create the deployment environment file:

```bash
cp .env.example .env
```

`.env` is a text file read by Docker Compose. At minimum, open it and set:

```dotenv
OPENAI_API_KEY=<provider-key>
SCOUT_SECRET_KEY=<long-random-value>
SCOUT_WORKER_SECRET=<different-long-random-value>
```

Generate secure values with:

```bash
openssl rand -hex 32
```

`OPENAI_API_KEY` lets Scout use OpenAI models. Replace it with another provider's key when appropriate.

`SCOUT_SECRET_KEY` protects signed-in user sessions. `SCOUT_WORKER_SECRET` protects communication between Scout and the separate code-execution service. Use different random values and do not share them.

Systems that mount secrets as files can use `*_FILE` variables instead:

```dotenv
OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
SCOUT_SECRET_KEY_FILE=/run/secrets/scout_secret_key
SCOUT_WORKER_SECRET_FILE=/run/secrets/scout_worker_secret
```

## 2. Configure models and defaults

Edit [`config/scout.yaml`](../config/scout.yaml) to choose models and deployment-wide behavior.
The file is mounted read-only into the Scout server.

For example, select an OpenAI model:

```yaml
agent:
  model: openai/gpt-5-mini

llm:
  providers:
    openai:
      models:
        - openai/gpt-5-mini
```

Read [Configuration](configuration.md) before changing provider labels, model IDs, or image support. Read [Local LLM setup](local-llm.md) to use Ollama or vLLM.

## 3. Launch

```bash
docker compose up --build -d
```

Open `http://localhost:4200`.

Confirm that every service is running:

```bash
docker compose ps
docker compose logs -f scout-server execution-worker
```

If the isolated execution service is unavailable, users may still sign in and browse files, but Scout disables generated-code execution.

## 4. Create the first administrator

By default, the first registered user becomes an administrator. To define administrators
explicitly:

```dotenv
SCOUT_ADMIN_USERS=alice,bob
```

Administrators can check service health, manage user permissions, and reload `config/scout.yaml` from **Admin → Config**.

## 5. Confirm it works

Sign in, start a new conversation, and send a short text message. Check that the expected model appears in the model selector. If it does not, verify its API key and exact model ID using [Configuration](configuration.md).

## Apply configuration changes

After editing `config/scout.yaml`, use Admin → Config → Reload config.

- Invalid YAML or unsupported sections are rejected.
- The previous valid configuration remains active after a failed reload.
- Reloaded values apply to new conversations and future background tasks.
- Existing conversations keep their current configuration snapshot.

After changing `.env` or `docker-compose.yml`, recreate the containers:

```bash
docker compose up --build -d
```

## Stored data

The `scout-data` Docker volume stores accounts and Scout's server data. User workspaces and shared files are stored under `./workspace` on the host.

Important locations:

```text
scout-data:/home/scout/.config/scout
./workspace/users/<user-id>
./workspace/shared
config/scout.yaml
```

## Operations

Stop services:

```bash
docker compose down
```

Rebuild and restart after code changes:

```bash
docker compose up --build -d
```

Removing the `scout-data` volume deletes authentication and persisted server state. Do not
remove it during normal upgrades.

## Local LLMs

To add Ollama or vLLM to the deployment, follow [Local LLM setup](local-llm.md).
