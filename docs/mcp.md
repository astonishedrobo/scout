# MCP integrations

Scout supports MCP tools through remote Streamable HTTP servers and isolated
container-based stdio servers. An administrator installs an integration once;
each allowed user can then decide whether to enable it.

## Method 1: add an integration from the web UI

Use this method to add or manage an MCP server while Scout is already running.
No Docker restart is required.

1. Sign in with an administrator account.
2. Open **Admin → Tools**.
3. Under **MCP integrations**, enter a name and choose a transport:
   - **Remote · Streamable HTTP:** enter the MCP endpoint URL and, if needed,
     a shared API token.
   - **Container · isolated stdio:** enter a digest-pinned container image
     such as `example/server@sha256:…` and its command if the image requires
     one.
4. Choose whether the integration is available to everyone or only selected
   users, then select **Add**.
5. Review the discovered tools. The administrator can disable individual tools
   or mark them as read-only.

The integration is saved in Scout's database and becomes available on the next
agent turn.

## Method 2: add an integration during deployment

Use this method when the MCP configuration should be reproducible as part of
the deployment.

```bash
npm run deploy
```

Open the wizard's **Integrations** step and add the remote or container MCP
server. The wizard saves the configuration in its resumable deployment draft
and applies it to `config/mcp.yaml` when **Apply & launch** is selected.
Re-running the deployment wizard loads the existing MCP configuration.

Remote integrations can use a deployment-managed Bearer credential. The
server definition stores only the environment variable name in
`credential_env`; the CLI writes the credential itself to `.env`. Exa Search
is available as a prefilled option in this step.

## Configure an integration manually

Keep connection metadata in `config/mcp.yaml` and secrets in the repository's
existing `.env` file:

```yaml
servers:
  - id: exa
    name: Exa Search
    transport: streamable_http
    url: https://mcp.exa.ai/mcp?tools=web_search_exa
    availability: everyone
    enabled: true
    auth_mode: bearer
    credential_env: EXA_API_KEY
```

```dotenv
EXA_API_KEY=your-key
```

Docker Compose makes `.env` available to Scout. The same pattern works for any
remote MCP server that accepts Bearer authentication: choose another
`credential_env` name and add its value to `.env`. No application code change
is needed. An enabled entry whose referenced variable is empty is skipped with
a warning; it does not prevent Scout from starting.

See [Deploy CLI](deploy-cli.md) for the complete deployment workflow.

## Enable an integration for a user

Installation and user access are separate:

1. The administrator installs the integration using either method above.
2. An allowed user opens **Settings → Integrations**.
3. The user enables the integration and, for remote servers that do not use a
   shared credential, saves their personal API token.

Users only receive tools from integrations they have enabled. MCP tool calls
use Scout's normal approval flow.

## Which method should I use?

| Need | Recommended method |
| --- | --- |
| Add or test an integration immediately | Web UI |
| Manage a running installation | Web UI |
| Recreate the same setup on another server | Deploy CLI |
| Keep MCP servers in deployment configuration | Deploy CLI |

You do not need to add the same integration through both methods.
