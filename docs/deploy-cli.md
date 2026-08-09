# Deploy CLI — Multi-User Server from a Fresh Clone

`scout deploy` is a full-screen terminal wizard that configures and launches
Scout's multi-user Docker deployment. It reads whatever is already configured
(`.env`, a saved draft), lets you edit only what you need, and hands off to
`docker compose`. For the manual, file-by-file route see
[deployment.md](deployment.md).

## Prerequisites

- Node.js ≥ 22.12 and npm
- Docker Engine + Docker Compose v2 (`docker compose`) or v1
  (`docker-compose`); the wizard detects either form
- One of: an OpenAI / Groq / Anthropic API key, or an NVIDIA GPU with the
  NVIDIA Container Toolkit for local vLLM

## Quick start

```bash
git clone https://github.com/astonishedrobo/scout.git scout
cd scout
npm install
npm run deploy
```

`npm run deploy` builds the CLI if needed (silently) and opens the wizard
directly. Everything is saved as you go to `.scout/deployment/draft.json`,
so you can quit at any point and resume later — nothing touches your system
until you confirm **Apply & launch** on the Review step.

The header's right corner tells you where the starting values came from:

- **loaded from current .env** — you have deployed before; the wizard is
  editing the live configuration (same secrets, keys, models, port).
- **resumed from saved draft** — an unfinished wizard run was found.
- **new configuration** — fresh clone, factory defaults.

## The three steps

### 1 · Providers

Every provider this deployment should offer, as a row of chips:

- `←`/`→` moves, `space` enables/disables a provider, `↵` opens it.
- Inside a provider: `Models`, `API key`, and `Endpoint` chips (✓ when set, gray when
  not), with the highlighted chip's current value shown underneath.
  The title says `— Configured` or `— Incomplete` so you always know
  what's missing.
- Model IDs don't need the litellm prefix — type `gpt-5-mini` and the
  wizard stores `openai/gpt-5-mini`. Enter multiple model IDs separated by
  commas. For local vLLM, type Hugging Face repo IDs; the `hosted_vllm/`
  prefix is applied automatically in the generated config.
- In any model list, `d` marks that model as the deployment **default**
  (the model new sessions start on — `agent.model` in `config/scout.yaml`).
  The current default carries a `✓ default` badge. With a single provider
  the default is chosen for you; with several, Review stays locked until
  you pick one with `d`.
- Local vLLM requires an NVIDIA GPU + Container Toolkit on this machine;
  the header shows `gpu ✓/✗`.

### 2 · Settings

Settings are grouped so the full form remains usable on a normal terminal:

- **Basic deployment** — admin usernames, public port, workspace/data paths,
  and bind address (`127.0.0.1` for local-only access or `0.0.0.0` for network access).
- **Model capabilities** — exact model IDs known to support or not support vision.
- **Agent behavior** — temperature, iteration limit, provider retries, and code timeout.
- **Server capacity** — live sessions, per-user sessions, request concurrency,
  queue limits, and queue timeout.
- **Code execution** — enabled state, default network policy, timeout, memory,
  and process limits.
- **Multi-agent** — enablement, concurrency, iteration limit, background defaults,
  and automatic continuation.
- **vLLM runtime** — image tag, GPU memory utilization, max model length,
  tensor parallelism, quantization, GPU selection, and parser settings.

Blank vLLM endpoint means the wizard creates one managed vLLM service per model.
Entering an endpoint uses an external/shared vLLM service instead.

### 3 · Review

A summary of every provider and setting. **Apply & launch** writes `.env`
(mode 600) and `config/scout.yaml`, creates the workspace directories
(asking for `sudo` only if their ownership must change to UID 1000, the
container user), and runs `docker compose up --build --detach`.
**Save draft & exit** writes nothing.

When compose finishes, open `http://localhost:<port>` and register — the
first account (or the listed admins) gets the admin role.

## Navigation reference

| Keys | Action |
| --- | --- |
| `←` `→` / `↑` `↓` | Move within the current screen |
| `↵` | Open / confirm |
| `space` | Toggle a provider on/off |
| `d` | Set highlighted model as the default |
| `esc` | Back one level (quits from the first screen) |
| `↑` from the top row | Focus the step bar — `←`/`→` pick a step, `↵` opens it |
| `ctrl+n` / `ctrl+p` | Next / previous step, works while typing too |
| `r` | Start over from factory defaults |
| `ctrl+c` | Quit (draft is kept) |

## After the first launch

```bash
npm run deploy:status         # docker compose ps
npm run deploy:logs           # recent server + worker logs
npm run deploy:restart        # restart services
npm run deploy:rebuild        # rebuild images and recreate services
npm run deploy:rebuild-clean  # rebuild without Docker cache
```

Re-running `npm run deploy` is always safe: it loads the current `.env`,
so you change one thing (add a provider, move a port) and re-apply without
retyping anything. Secrets are never rotated on re-apply.

## Where everything lives

| Path | Purpose |
| --- | --- |
| `.env` | Ports, API keys, secrets, paths — read by `docker-compose.yml` |
| `config/scout.yaml` | Agent + provider/model configuration |
| `.scout/deployment/draft.json` | Resumable wizard state (mode 600) |
| `<workspace>/users`, `<workspace>/shared` | Per-user and shared files |
| `scout-data` volume (or your chosen path) | Database, sessions |

The CLI has no private configuration channel: it only writes the files
above, which `docker compose` consumes on its own. You can edit them by
hand or delete the CLI entirely and the deployment still works.

## MCP integrations

`npm run deploy` includes an **Integrations** step for remote Streamable HTTP
servers and advanced digest-pinned container stdio servers. Admin-installed MCP servers
are saved in the resumable deployment draft and applied to `config/mcp.yaml`
with the rest of the deployment. Re-running the wizard loads the current MCP
configuration, so integrations are not lost or re-entered.

The step includes a prefilled Exa Search integration. Remote integrations may
also reference a Bearer credential by environment-variable name. The CLI keeps
that reference in `config/mcp.yaml` and writes the credential value to the same
`.env` file used for model-provider keys. Manual Docker deployments use the
same two-file convention.

After launch, the admin **Tools** panel can manage live integrations. Users opt
in from **Settings → Integrations**; credentials are stored per user and
encrypted with `SCOUT_SECRET_KEY`. A failed MCP connection is a warning and
does not stop Scout.
