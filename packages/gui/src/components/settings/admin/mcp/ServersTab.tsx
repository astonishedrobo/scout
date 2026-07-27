import { useState } from "react";
import { ChevronRight, Plug, Trash2 } from "lucide-react";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  IconButton,
  PasswordInput,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  Skeleton,
  Switch,
} from "../../../ui";
import { serverState, type McpActions, type McpServer } from "./types";

/**
 * One summary row per server, expanding to that server's settings.
 *
 * Previously every server rendered its whole control surface at once — token
 * field, availability select, user pills, tool list — so five installed servers
 * produced a page nobody could scan. The summary row now answers "is it working"
 * for all of them at a glance, and the detail is one click away.
 */
export function ServersTab({
  servers,
  loading,
  actions,
}: {
  servers: McpServer[];
  loading: boolean;
  actions: McpActions;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (loading) {
    return (
      <SettingsGroup label="Installed" description="Servers published to this workspace.">
        <div className="px-4 py-3">
          <Skeleton.List rows={3} />
        </div>
      </SettingsGroup>
    );
  }

  if (servers.length === 0) {
    return (
      <SettingsGroup label="Installed" description="Servers published to this workspace.">
        <EmptyState
          size="sm"
          icon={<Plug size={20} />}
          title="No integrations installed"
          body="Add a server to make its tools available."
        />
      </SettingsGroup>
    );
  }

  const failing = servers.filter((s) => s.health?.error);

  return (
    <>
      {failing.length > 0 && (
        <Banner
          tone="error"
          variant="inline"
          messages={failing.map((s) => `${s.name}: ${s.health?.error}`)}
        />
      )}

      <SettingsGroup label="Installed" description="Servers published to this workspace.">
        {servers.map((server) => {
          const state = serverState(server);
          const expanded = open === server.id;
          const toolCount = server.tools?.length ?? server.health?.tool_count ?? 0;

          return (
            <SettingsRow
              key={server.id}
              label={
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : server.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 items-center gap-2 rounded-btn text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
                >
                  <ChevronRight
                    size={13}
                    aria-hidden="true"
                    className={`shrink-0 text-scout-muted transition-transform duration-fast ${
                      expanded ? "rotate-90" : ""
                    }`}
                  />
                  <span className="truncate">{server.name}</span>
                  <Badge tone={state.tone} uppercase>
                    {state.label}
                  </Badge>
                  {!server.enabled && (
                    <Badge tone="neutral" uppercase>
                      off
                    </Badge>
                  )}
                </button>
              }
              description={[
                server.transport === "container_stdio" ? "Container" : "Remote",
                server.url ?? server.image ?? "",
                `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
                server.availability === "selected"
                  ? `${server.assigned_user_ids?.length ?? 0} assigned`
                  : "everyone",
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                <>
                  <Switch
                    checked={server.enabled}
                    onChange={() => actions.toggleServer(server)}
                    label={`Enable ${server.name}`}
                  />
                  <IconButton
                    label={`Remove ${server.name}`}
                    tone="danger"
                    onClick={() => actions.removeServer(server)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </>
              }
            >
              {expanded && (
                <div className="mt-3 space-y-3.5 border-t border-scout-hairline-faint pt-3.5">
                  {/* Surfaced here too, not only in the banner: an admin who
                      expanded this server to fix it should see why it failed. */}
                  {state.error && (
                    <p className="text-caption leading-relaxed text-scout-error">{state.error}</p>
                  )}

                  <div className="flex items-center justify-between gap-3">
                    <span className="text-caption text-scout-muted">Availability</span>
                    <SettingsSelect
                      value={server.availability}
                      onChange={(next) => actions.changeAvailability(server, next)}
                      label={`Availability for ${server.name}`}
                      options={[
                        {
                          value: "everyone",
                          label: "Everyone",
                          description: "Any user can enable it in Connections",
                        },
                        {
                          value: "selected",
                          label: "Selected users",
                          description: "Only users you assign in the Access tab",
                        },
                      ]}
                    />
                  </div>

                  {server.transport !== "container_stdio" && (
                    <div>
                      <div className="flex items-end gap-2">
                        <PasswordInput
                          size="sm"
                          aria-label={`Shared token for ${server.name}`}
                          value={drafts[server.id] ?? ""}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [server.id]: e.target.value }))
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
                          disabled={!drafts[server.id]?.trim()}
                          onClick={async () => {
                            await actions.saveSharedCredential(server, drafts[server.id].trim());
                            setDrafts((d) => ({ ...d, [server.id]: "" }));
                          }}
                        >
                          Save
                        </Button>
                      </div>
                      <p className="mt-1.5 text-micro text-scout-muted">
                        {server.has_shared_credential
                          ? "A shared token is stored. Users who save their own override it."
                          : "Optional. Used for every user unless they save their own."}
                      </p>
                    </div>
                  )}

                  <p className="text-micro text-scout-muted">
                    Assign users in the <span className="text-scout-text">Access</span> tab; change
                    tool permissions in <span className="text-scout-text">Tools</span>.
                  </p>
                </div>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </>
  );
}
