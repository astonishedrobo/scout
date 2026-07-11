# Scout

Scout is an AI research agent that can run for one person on a computer or for multiple users on a server.

## Choose a Setup

Use **local single-user** when you are testing Scout or running it for yourself. Use **Docker multi-user** when several people need accounts and separate workspaces.

### Local single-user

```bash
npm install
npm run build
node packages/scout/dist/index.js --gui
```

This opens Scout in your browser. Before starting, set an API key such as `OPENAI_API_KEY`, or configure a local model. Follow [Local single-user setup](docs/local-setup.md) for the complete instructions.

### Docker multi-user

```bash
npm run deploy
```

The deployment wizard checks Docker and the GPU, saves an interrupted setup as a
draft, repairs mounted-workspace ownership with a scoped `sudo` command, and
launches Scout. Use `npm run deploy:status`, `npm run deploy:logs`,
`npm run deploy:restart`, or `npm run deploy:rebuild-clean` for later
operations. Manual setup remains documented in
[Docker multi-user deployment](docs/deployment.md).

Docker Compose is the only supported multi-user deployment path.

## Documentation

- [Local single-user setup](docs/local-setup.md): install, configure, and launch Scout for yourself
- [Deploy CLI](docs/deploy-cli.md): the `npm run deploy` terminal wizard, step by step
- [Docker multi-user deployment](docs/deployment.md): deploy Scout for multiple users
- [Configuration](docs/configuration.md): understand configuration files, model IDs, and image support
- [Local LLM setup](docs/local-llm.md): connect Scout to Ollama or vLLM

Other files under `docs/` are internal design or reference material and are not primary setup documentation.
