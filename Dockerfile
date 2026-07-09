# Stage 1: Build the React GUI
FROM node:22-slim AS builder

WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY package.json package-lock.json* ./
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/gui-app/package.json ./packages/gui-app/package.json
COPY packages/gui/package.json ./packages/gui/package.json
COPY packages/scout/package.json ./packages/scout/package.json

RUN npm ci

COPY packages/ ./packages/
COPY python/ ./python/
RUN npm run build:core && npm run build:gui

# Stage 2: Serve the Python backend with the GUI
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    bubblewrap \
    socat \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI only (no daemon) — the execution-worker uses it to launch
# per-session sandbox containers via the constrained docker-socket-proxy.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

COPY python/pyproject.toml python/requirements.txt ./python/
RUN cd python && pip install --no-cache-dir -r requirements.txt pytest pytest-asyncio

COPY python/ ./python/
RUN cd python && pip install --no-cache-dir -e .

COPY --from=builder /app/packages/gui/dist ./gui-dist

# NOTE: do NOT bake /srv/scout-source into the image — the sandbox isolation
# probe asserts that path is absent in a bare container of this image (it only
# exists where compose bind-mounts the workspace, i.e. in the worker).
RUN groupadd -r scout && useradd -r -g scout -u 1000 scout \
    && mkdir -p /home/scout/.config/scout/sessions /app/workspace \
    && chown -R scout:scout /home/scout /app/workspace

USER scout

EXPOSE 4200

ENV PYTHONUNBUFFERED=1
ENV HOME=/home/scout

CMD ["python", "-m", "scout.server", "--cwd", "/app/workspace", "--host", "0.0.0.0", "--port", "4200", "--serve-gui", "/app/gui-dist/web"]
