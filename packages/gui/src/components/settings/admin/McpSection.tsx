import { useCallback, useEffect, useState } from "react";
import { Plug, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  PasswordInput,
  Segmented,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  Switch,
  type ConfirmRequest,
} from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";

interface McpTool {
  name: string;
  description?: string;
  read_only?: boolean;
  enabled?: boolean;
}

interface McpServer {
  id: string;
  name: string;
  transport: string;
  url?: string;
  image?: string;
  enabled: boolean;
  availability: string;
  health?: { status?: string; tool_count?: number; error?: string };
  tools?: McpTool[];
  assigned_user_ids?: number[];
  has_shared_credential?: boolean;
}

interface UserEntry {
  id: number;
  username: string;
}

type Transport = "streamable_http" | "container_stdio";

export function McpSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [sharedDrafts, setSharedDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Add-server form
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("streamable_http");
  const [url, setUrl] = useState("");
  const [image, setImage] = useState("");
  const [command, setCommand] = useState("");
  const [credential, setCredential] = useState("");
  const [availability, setAvailability] = useState<"everyone" | "selected">("everyone");
  const [saving, setSaving] = useState(false);

  const fail = useCallback(
    async (r: Response, fallback: string) => {
      setStatus({ message: await errorDetail(r, fallback), tone: "error" });
    },
    [setStatus],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [serversRes, usersRes] = await Promise.all([
        fetch(`${baseUrl}/admin/mcp/servers`, { headers: authHeaders }),
        fetch(`${baseUrl}/admin/users`, { headers: authHeaders }),
      ]);
      if (!serversRes.ok) throw new Error(await errorDetail(serversRes, "Could not load MCP servers."));
      setServers((await serversRes.json()).servers ?? []);
      if (usersRes.ok) setUsers((await usersRes.json()).users ?? []);
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not load MCP servers.", tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [baseUrl, authHeaders, setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchServer = async (server: McpServer, body: unknown, success?: string) => {
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return fail(r, "Could not update that integration.");
    await load();
    if (success) setStatus({ message: success, tone: "info" });
  };

  const add = async () => {
    if (!name.trim()) return setStatus({ message: "Enter an integration name.", tone: "error" });
    if (transport === "streamable_http" && !url.trim())
      return setStatus({ message: "Enter an MCP URL.", tone: "error" });
    if (transport === "container_stdio" && !image.trim())
      return setStatus({ message: "Enter a digest-pinned container image.", tone: "error" });

    const parts = command.trim().split(/\s+/).filter(Boolean);
    setSaving(true);
    try {
      const r = await fetch(`${baseUrl}/admin/mcp/servers`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          id: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          transport,
          url: transport === "streamable_http" ? url.trim() : undefined,
          image: transport === "container_stdio" ? image.trim() : undefined,
          command: transport === "container_stdio" && parts.length ? [parts[0]] : [],
          args: transport === "container_stdio" ? parts.slice(1) : [],
          shared_credential:
            transport === "streamable_http" ? credential.trim() || undefined : undefined,
          availability,
          enabled: true,
        }),
      });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not add that integration."));
      setName("");
      setUrl("");
      setImage("");
      setCommand("");
      setCredential("");
      setTransport("streamable_http");
      setAvailability("everyone");
      await load();
      setStatus({ message: "Integration added.", tone: "info" });
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not add integration.", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Enabling is safe; disabling takes the integration away from every user.
  const toggleServer = (server: McpServer) => {
    if (!server.enabled) {
      void patchServer(server, { enabled: true }, `${server.name} enabled.`);
      return;
    }
    setConfirm({
      title: `Disable ${server.name}?`,
      body: `Every user loses access to this integration's ${server.tools?.length ?? 0} tools until it is enabled again.`,
      confirmLabel: "Disable",
      onConfirm: () => patchServer(server, { enabled: false }, `${server.name} disabled.`),
    });
  };

  const removeServer = (server: McpServer) =>
    setConfirm({
      title: `Remove ${server.name}?`,
      body: "The integration and its stored credentials are deleted. This cannot be undone.",
      destructive: true,
      confirmLabel: "Remove",
      onConfirm: async () => {
        const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, {
          method: "DELETE",
          headers: authHeaders,
        });
        if (!r.ok) return fail(r, "Could not remove that integration.");
        await load();
        setStatus({ message: `${server.name} removed.`, tone: "info" });
      },
    });

  const changeAvailability = (server: McpServer, next: string) => {
    if (next === server.availability) return;
    const apply = () =>
      patchServer(server, { availability: next }, `${server.name} is now available to ${next}.`);
    // Narrowing from everyone to a list revokes access for anyone not on it.
    if (next === "selected") {
      setConfirm({
        title: `Limit ${server.name} to selected users?`,
        body: "Anyone not on the list loses access until you assign them.",
        confirmLabel: "Limit access",
        onConfirm: apply,
      });
      return;
    }
    void apply();
  };

  const assignUser = (server: McpServer, user: UserEntry, assigned: boolean) => {
    const apply = async () => {
      const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}/users/${user.id}`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ assigned }),
      });
      if (!r.ok) return fail(r, "Could not update assignment.");
      await load();
      setStatus({
        message: `${user.username} ${assigned ? "can" : "can no longer"} use ${server.name}.`,
        tone: "info",
      });
    };
    if (!assigned) {
      setConfirm({
        title: `Remove ${user.username} from ${server.name}?`,
        body: `${user.username} loses access to this integration's tools.`,
        confirmLabel: "Remove access",
        onConfirm: apply,
      });
      return;
    }
    void apply();
  };

  const setToolPolicy = (
    server: McpServer,
    tool: McpTool,
    change: { enabled?: boolean; read_only?: boolean },
  ) => {
    const apply = async () => {
      const r = await fetch(
        `${baseUrl}/admin/mcp/servers/${server.id}/tools/${encodeURIComponent(tool.name)}`,
        {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(change),
        },
      );
      if (!r.ok) return fail(r, "Could not update that tool.");
      await load();
      setStatus({ message: `${tool.name} updated.`, tone: "info" });
    };
    // Granting write access widens what the agent can do without asking.
    if (change.read_only === false) {
      setConfirm({
        title: `Allow ${tool.name} to write?`,
        body: `${tool.name} will be able to make changes through ${server.name}, not just read. Users can invoke it without a separate approval.`,
        confirmLabel: "Allow writes",
        onConfirm: apply,
      });
      return;
    }
    // Turning a tool off removes it from every user's agent mid-session.
    if (change.enabled === false) {
      setConfirm({
        title: `Turn off ${tool.name}?`,
        body: `Agents can no longer call ${tool.name} through ${server.name}.`,
        confirmLabel: "Turn off",
        onConfirm: apply,
      });
      return;
    }
    void apply();
  };

  return (
    <>
      <SettingsGroup
        label="Add an integration"
        description="Install a remote MCP server, or a digest-pinned container. Users enable allowed integrations in Connections."
        action={
          <Button variant="outlined" surface="panel" size="compact" onClick={add} loading={saving}>
            Add
          </Button>
        }
      >
        <SettingsRow label="Name" description="Shown to users.">
          <Input
            size="sm"
            aria-label="Integration name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Asana"
            className="mt-3"
          />
        </SettingsRow>
        <SettingsRow
          label="Connection"
          description="How Scout reaches the server."
          control={
            <Segmented
              value={transport}
              onChange={setTransport}
              label="Transport"
              options={[
                { value: "streamable_http", label: "Remote" },
                { value: "container_stdio", label: "Container" },
              ]}
            />
          }
        />
        {transport === "streamable_http" ? (
          <>
            <SettingsRow label="URL">
              <Input
                size="sm"
                aria-label="MCP URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/sse"
                className="mt-3"
              />
            </SettingsRow>
            <SettingsRow
              label="Shared token"
              description="Optional. Used for every user unless they save their own."
            >
              <PasswordInput
                size="sm"
                aria-label="Shared credential"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder="Optional"
                className="mt-3"
              />
            </SettingsRow>
          </>
        ) : (
          <>
            <SettingsRow label="Image" description="Must be digest-pinned.">
              <Input
                size="sm"
                aria-label="Container image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="ghcr.io/org/server@sha256:…"
                className="mt-3 font-mono"
              />
            </SettingsRow>
            <SettingsRow label="Command" description="Optional override, space separated.">
              <Input
                size="sm"
                aria-label="Command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="node server.js --stdio"
                className="mt-3 font-mono"
              />
            </SettingsRow>
          </>
        )}
        <SettingsRow
          label="Availability"
          description="Who may enable it."
          control={
            <Segmented
              value={availability}
              onChange={setAvailability}
              label="Availability"
              options={[
                { value: "everyone", label: "Everyone" },
                { value: "selected", label: "Selected" },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="Installed" description="Servers published to this workspace.">
        {loading ? (
          <SettingsRow label="Loading integrations…" />
        ) : servers.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Plug size={20} />}
            title="No integrations installed"
            body="Add a server above to make its tools available."
          />
        ) : (
          servers.map((server) => (
            <SettingsRow
              key={server.id}
              label={
                <span className="flex items-center gap-2">
                  {server.name}
                  <Badge tone={server.health?.status === "ok" ? "success" : "neutral"}>
                    {server.health?.status ?? "not connected"}
                  </Badge>
                </span>
              }
              description={[
                server.transport === "container_stdio" ? "Container" : "Remote",
                server.url ?? server.image ?? "",
                `${server.tools?.length ?? 0} tools`,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                <>
                  <Switch
                    checked={server.enabled}
                    onChange={() => toggleServer(server)}
                    label={`Enable ${server.name}`}
                  />
                  <IconButton
                    label={`Remove ${server.name}`}
                    tone="danger"
                    onClick={() => removeServer(server)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </>
              }
            >
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-scout-muted">Availability</span>
                  <SettingsSelect
                    value={server.availability}
                    onChange={(next) => changeAvailability(server, next)}
                    label={`Availability for ${server.name}`}
                    options={[
                      { value: "everyone", label: "Everyone" },
                      { value: "selected", label: "Selected users" },
                    ]}
                  />
                </div>

                {server.transport !== "container_stdio" && (
                  <div className="flex items-end gap-2">
                    <PasswordInput
                      size="sm"
                      aria-label={`Shared token for ${server.name}`}
                      value={sharedDrafts[server.id] ?? ""}
                      onChange={(e) =>
                        setSharedDrafts((d) => ({ ...d, [server.id]: e.target.value }))
                      }
                      placeholder={
                        server.has_shared_credential ? "Replace shared token" : "Shared token"
                      }
                      className="min-w-0 flex-1"
                    />
                    <Button
                      variant="outlined"
                      surface="panel"
                      size="compact"
                      disabled={!sharedDrafts[server.id]?.trim()}
                      onClick={async () => {
                        await patchServer(
                          server,
                          { shared_credential: sharedDrafts[server.id].trim() },
                          `Shared token saved for ${server.name}.`,
                        );
                        setSharedDrafts((d) => ({ ...d, [server.id]: "" }));
                      }}
                    >
                      Save
                    </Button>
                  </div>
                )}

                {server.availability === "selected" && users.length > 0 && (
                  <div>
                    <span className="text-caption text-scout-muted">Assigned users</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {users.map((user) => {
                        const assigned = server.assigned_user_ids?.includes(user.id) ?? false;
                        return (
                          <button
                            key={user.id}
                            type="button"
                            aria-pressed={assigned}
                            onClick={() => assignUser(server, user, !assigned)}
                            className={`rounded-pill border px-2.5 py-1 text-micro font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
                              assigned
                                ? "border-scout-success/30 bg-scout-success-muted text-scout-success"
                                : "border-scout-hairline-faint text-scout-muted hover:text-scout-text"
                            }`}
                          >
                            {user.username}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {server.tools && server.tools.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-caption text-scout-muted hover:text-scout-text">
                      {server.tools.length} tools
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {server.tools.map((tool) => (
                        <li key={tool.name} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-micro text-scout-text">
                            {tool.name}
                          </span>
                          <button
                            type="button"
                            aria-pressed={tool.read_only !== false}
                            onClick={() => setToolPolicy(server, tool, { read_only: tool.read_only === false })}
                            className="rounded-pill border border-scout-hairline-faint px-2 py-0.5 text-micro font-medium text-scout-muted transition-colors hover:text-scout-text focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
                          >
                            {tool.read_only === false ? "read + write" : "read only"}
                          </button>
                          <Switch
                            checked={tool.enabled !== false}
                            onChange={(next) => setToolPolicy(server, tool, { enabled: next })}
                            label={`Enable ${tool.name}`}
                          />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </SettingsRow>
          ))
        )}
      </SettingsGroup>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
