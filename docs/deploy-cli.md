# Deploy CLI — Multi-User Server from a Fresh Clone

`scout deploy` is a full-screen terminal wizard that configures and launches
Scout's multi-user Docker deployment. It reads whatever is already configured
(`.env`, a saved draft), lets you edit only what you need, and hands off to
`docker compose`. For the manual, file-by-file route see
[deployment.md](deployment.md).

## Prerequisites

- Node.js ≥ 22.12 and npm
- Docker Engine + Docker Compose (the wizard checks both and refuses to
  continue without them)
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
- Inside a provider: `Model` and `API key` chips (✓ when set, gray when
  not), with the highlighted chip's current value shown underneath.
  The title says `— Configured` or `— Incomplete` so you always know
  what's missing.
- Model IDs don't need the litellm prefix — type `gpt-5-mini` and the
  wizard stores `openai/gpt-5-mini`. For local vLLM, type the Hugging Face
  repo ID (`Qwen/Qwen3-1.7B`); the `hosted_vllm/` prefix is applied
  automatically in the generated config.
- In any model list, `d` marks that model as the deployment **default**
  (the model new sessions start on — `agent.model` in `config/scout.yaml`).
  The current default carries a `✓ default` badge. With a single provider
  the default is chosen for you; with several, Review stays locked until
  you pick one with `d`.
- Local vLLM requires an NVIDIA GPU + Container Toolkit on this machine;
  the header shows `gpu ✓/✗`.

### 2 · Settings

- **Admin usernames** — comma-separated; blank makes the first registered
  user the admin.
- **Public Scout port** — default 4200.
- **Workspace location** — host directory holding `users/` and `shared/`
  (the files people see in Scout). Default `./workspace` in the repo;
  set an absolute path to keep it elsewhere.
- **Server data** — database and sessions. Blank keeps the default
  Docker-managed `scout-data` volume; a path bind-mounts it to a
  browsable host folder instead.

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
