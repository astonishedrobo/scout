# Scout Server Deployment Guide

Scout can be deployed in **Multi-User Server Mode**, which provides isolated per-user sessions, hash-based chat URLs, and hardened security. This guide covers how to launch the server using the recommended `run.py` script, manual local commands, or Docker.

## 🚀 The Recommended Way (`run.py`)

The root directory contains a `run.py` script that orchestrates the entire build and launch process. This is the easiest way to get started.

### Prerequisites
- Python 3.9+
- Node.js 18+

### Commands
Launch the server on the default port (3030):
```bash
python3 run.py --multi-user
```

**Common Flags:**
- `-p, --port`: Specify a custom port (e.g., `-p 8080`).
- `--build`: Recompile both frontend and backend before starting.
- `-c, --config`: Path to a custom `config.yaml`.
- `--docker`: Orchestrates the Docker Compose flow for you.

---

## 💻 Local Setup (Manual)

If you prefer to run the components manually without the helper script:

1. **Build the packages**:
   ```bash
   npm install
   npm run build
   ```

2. **Start the Scout CLI in GUI mode**:
   ```bash
   node packages/scout/dist/index.js --gui --multi-user -p 3030
   ```
   *The server will automatically start the Python backend and wait for it to be healthy.*

---

## 🐳 Docker Deployment

Docker is recommended for production-like environments or when you want to avoid local dependency management.

### Quick Start
Ensure you have `docker-compose.yml` and `Dockerfile` in the root, then run:
```bash
docker compose up --build -d
```
The GUI will be available at [http://localhost:4200](http://localhost:4200).

### Persistent Data
Scout uses a Docker volume named `scout-data` to persist:
- `scout_users.db`: User credentials.
- `sessions/`: Chat history and messages.
- `config.yaml`: Global settings.

---

## ⚙️ Configuration & Security

### API Keys
Provide your LLM provider keys via environment variables or `config.yaml`. Supported providers: `OPENAI`, `ANTHROPIC`, `GROQ`.

### Authentication Security
When running in `--multi-user` mode, you **must** set a permanent secret key to ensure user sessions remain valid across restarts:

```bash
export SCOUT_SECRET_KEY="your-long-random-secret-string"
```
In Docker, this is managed in the `environment` section of `docker-compose.yml`.

### User Registration
On first launch, navigate to the GUI and use the **Register** link. The first user created will have their own isolated workspace and chat history.
