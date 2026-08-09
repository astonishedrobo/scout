import { useEffect, useMemo, useState } from "react";
import { Plug } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  PasswordInput,
  SettingsGroup,
  SettingsRow,
  SubTabs,
  Switch,
} from "../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "./shared";

interface Integration {
  id: string;
  name: string;
  transport?: string;
  auth_mode?: "none" | "bearer";
  tools?: unknown[];
  health?: { status?: string };
  has_credential?: boolean;
  credential_source?: "shared" | "user" | "none";
  user_enabled?: boolean;
}

type Filter = "all" | "enabled" | "setup";

/**
 * The user's view of the MCP integrations an administrator has published.
 *
 * Server management (adding servers, tool policy, who may see what) is an admin
 * concern and lives in Workspace → MCP tools.
 */
export function ConnectionsSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${baseUrl}/mcp/integrations`, { headers: authHeaders })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorDetail(r, "Could not load integrations."));
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setIntegrations(d.integrations ?? []);
      })
      .catch((e: Error) => setStatus({ message: e.message, tone: "error" }))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, authHeaders, setStatus]);

  // Only bearer-authenticated servers without either a shared or personal
  // credential need user setup. Public remote MCPs require no token at all.
  const needsSetup = (i: Integration) =>
    i.transport !== "container_stdio" &&
    i.auth_mode === "bearer" &&
    i.credential_source !== "shared" &&
    !i.has_credential;

  const counts = useMemo(
    () => ({
      all: integrations.length,
      enabled: integrations.filter((i) => i.user_enabled).length,
      setup: integrations.filter(needsSetup).length,
    }),
    [integrations],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return integrations
      .filter((i) =>
        filter === "enabled" ? i.user_enabled : filter === "setup" ? needsSetup(i) : true,
      )
      .filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [integrations, filter, query]);

  const toggle = async (integration: Integration) => {
    const enabled = !integration.user_enabled;
    const r = await fetch(`${baseUrl}/mcp/integrations/${integration.id}/enabled`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) {
      setStatus({ message: await errorDetail(r, "Could not update integration."), tone: "error" });
      return;
    }
    setIntegrations((items) =>
      items.map((i) => (i.id === integration.id ? { ...i, user_enabled: enabled } : i)),
    );
    setStatus({ message: `${integration.name} ${enabled ? "enabled" : "disabled"}.`, tone: "info" });
  };

  const saveCredential = async (integration: Integration) => {
    const credential = drafts[integration.id]?.trim();
    if (!credential) return;
    const r = await fetch(`${baseUrl}/mcp/integrations/${integration.id}/credentials`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!r.ok) {
      setStatus({ message: await errorDetail(r, "Could not save credential."), tone: "error" });
      return;
    }
    setDrafts((items) => ({ ...items, [integration.id]: "" }));
    setIntegrations((items) =>
      items.map((i) =>
        i.id === integration.id ? { ...i, user_enabled: true, has_credential: true } : i,
      ),
    );
    setStatus({ message: `Token saved for ${integration.name}.`, tone: "info" });
  };

  return (
    <>
      <SubTabs
        tabs={[
          { id: "all", label: "All", count: counts.all },
          { id: "enabled", label: "Enabled", count: counts.enabled },
          { id: "setup", label: "Needs setup", count: counts.setup },
        ]}
        value={filter}
        onChange={(next) => setFilter(next as Filter)}
        search={{ value: query, onChange: setQuery, placeholder: "Search connections" }}
      />

      <SettingsGroup
        label="Connections"
        description="Tools your administrator has made available to your agent."
      >
        {loading ? (
          <SettingsRow label="Loading connections…" />
        ) : visible.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Plug size={20} />}
            title={integrations.length === 0 ? "No connections yet" : "Nothing matches"}
            body={
              integrations.length === 0
                ? "An administrator has not published any integrations to this workspace."
                : "Try a different filter or search term."
            }
          />
        ) : (
          visible.map((integration) => {
            const remote = integration.transport !== "container_stdio";
            const acceptsUserCredential =
              remote &&
              integration.auth_mode === "bearer" &&
              integration.credential_source !== "shared";
            return (
              <SettingsRow
                key={integration.id}
                label={
                  <span className="flex items-center gap-2">
                    {integration.name}
                    {needsSetup(integration) && <Badge tone="warning">Needs token</Badge>}
                  </span>
                }
                description={[
                  remote ? "Remote" : "Isolated container",
                  `${integration.tools?.length ?? 0} tools`,
                  integration.health?.status ?? "not connected",
                ].join(" · ")}
                control={
                  <Switch
                    checked={!!integration.user_enabled}
                    onChange={() => toggle(integration)}
                    label={`Enable ${integration.name}`}
                  />
                }
              >
                {acceptsUserCredential && (
                  <div className="mt-3 flex items-end gap-2">
                    <PasswordInput
                      size="sm"
                      aria-label={`API token for ${integration.name}`}
                      value={drafts[integration.id] ?? ""}
                      onChange={(e) =>
                        setDrafts((items) => ({ ...items, [integration.id]: e.target.value }))
                      }
                      placeholder={
                        integration.has_credential ? "Replace saved token" : "API token"
                      }
                      className="min-w-0 flex-1"
                    />
                    <Button
                      variant="outlined"
                      surface="panel"
                      size="compact"
                      onClick={() => saveCredential(integration)}
                      disabled={!drafts[integration.id]?.trim()}
                    >
                      Save
                    </Button>
                  </div>
                )}
              </SettingsRow>
            );
          })
        )}
      </SettingsGroup>
    </>
  );
}
