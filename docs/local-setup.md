# Local Single-User Setup

Use this setup when Scout is for one person on one computer. Local launches do not create user accounts and must not be shared as a multi-user server. For multiple users, follow [Docker multi-user deployment](deployment.md).

## Prerequisites

- Node.js 18+
- Python 3.11+
- An API key for a model provider, or a locally running model
- Bubblewrap on Linux if you want Scout to run generated code

## 1. Install and build

```bash
npm install
npm run build
```

This installs Scout's dependencies and builds its browser, terminal, desktop, and Python components.

## 2. Configure a model

For an OpenAI model, set your API key:

```bash
export OPENAI_API_KEY="your-key"
```

Scout's default configuration contains the available provider and model entries. To select or add a model, create a YAML configuration file and pass it when launching:

```yaml
agent:
  model: openai/gpt-5-mini

llm:
  providers:
    openai:
      models:
        - openai/gpt-5-mini
```

See [Configuration](configuration.md) before changing model names. The same model ID must be written exactly the same way in each relevant setting.

For Ollama or vLLM, follow [Local LLM setup](local-llm.md).

## 3. Launch Scout

### Terminal UI

```bash
node packages/scout/dist/index.js
```

### Browser GUI

```bash
node packages/scout/dist/index.js --gui
```

Use `-p` to choose a port:

```bash
node packages/scout/dist/index.js --gui -p 3030
```

### Desktop App

```bash
node packages/scout/dist/index.js --app
```

### Python API Server

Use this option when you only need Scout's HTTP API. Install the Python package, then start the server:

```bash
python -m pip install -r python/requirements.txt
python -m pip install -e python
python -m scout.server --cwd "$(pwd)" --port 7890
```

## 4. Confirm it works

Open Scout, start a new conversation, and send a short text message. If the selected model does not appear or the message fails, check its API key and model ID using [Configuration](configuration.md).

## Configuration file locations

Scout merges local configuration in this order:

1. Built-in defaults
2. `~/.config/scout/config.yaml`
3. An explicitly supplied project config

Pass a project config to the Node launcher:

```bash
node packages/scout/dist/index.js --gui --config .scout/config.yaml
```

Or to the Python server:

```bash
python -m scout.server --config .scout/config.yaml
```

Settings loaded later replace earlier settings. See [Configuration](configuration.md) for provider setup, memory controls, and model image support.

## API Keys

Keep API keys outside YAML files. Set them as environment variables before launching Scout:

```bash
export OPENAI_API_KEY="..."
export GROQ_API_KEY="..."
export ANTHROPIC_API_KEY="..."
```

Provider model lists and the default model belong in YAML configuration, not environment variables.

## Code Execution

Scout runs model-generated code only when it can isolate that code from the rest of your computer. If isolation is unavailable, Scout disables code execution instead.

On Linux, install bubblewrap:

```bash
sudo apt-get install bubblewrap
```

Do not use local launch commands for multi-user access. Multi-user Scout requires the isolated Docker execution service described in [Docker multi-user deployment](deployment.md).
