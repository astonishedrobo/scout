# Stage 1: Build the React GUI
FROM node:20-slim AS builder

WORKDIR /app

# Copy workspace setup and source
COPY package.json package-lock.json* ./
COPY packages/ ./packages/

# Install dependencies and build
RUN npm install
RUN npm run build:gui

# Stage 2: Serve the Python backend with the GUI
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install python requirements
COPY python/pyproject.toml python/requirements.txt ./python/
RUN cd python && pip install --no-cache-dir -r requirements.txt

# Install the scout python package
COPY python/ ./python/
RUN cd python && pip install --no-cache-dir -e .

# Copy built GUI from builder
COPY --from=builder /app/packages/gui/dist ./gui-dist

# Create necessary directories
RUN mkdir -p /root/.config/scout/sessions /app/workspace

# Expose the server port
EXPOSE 4200

# Environment variables
ENV PYTHONUNBUFFERED=1

# Entrypoint to run the scout server in multi-user mode with the GUI
CMD ["python", "-m", "scout.server", "--cwd", "/app/workspace", "--host", "0.0.0.0", "--port", "4200", "--serve-gui", "/app/gui-dist", "--multi-user"]
