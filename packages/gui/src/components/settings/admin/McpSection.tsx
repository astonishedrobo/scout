import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button, ConfirmDialog, SubTabs, type ConfirmRequest, type SubTab } from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";
import { AddServerForm, type NewServer } from "./mcp/AddServerForm";
import { ServersTab } from "./mcp/ServersTab";
import { AccessTab } from "./mcp/AccessTab";
import { ToolsTab } from "./mcp/ToolsTab";
import type { McpActions, McpServer, McpTool, UserEntry } from "./mcp/types";

type Tab = "servers" | "access" | "tools";

/**
 * MCP administration: Servers, Access, Tools.
 *
 * This was one 524-line component rendering every server's entire control surface
 * simultaneously, with the add-server form permanently occupying the top of the
 * page. Splitting it by question — what is installed, who may use it, what may it
 * do — makes each surface scannable.
 *
 * Data is fetched once here and passed down, and every mutation lives here too,
 * so the confirmation copy stays in one place. That copy is the most careful
 * writing in the admin area: each dialog states the blast radius in concrete
 * terms (how many tools, which user, what capability widens), and all of it is
 * preserved verbatim through this refactor.
 */
export function McpSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("servers");
  const [adding, setAdding] = useState(false);
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
      if (!serversRes.ok)
        throw new Error(await errorDetail(serversRes, "Could not load MCP servers."));
      setServers((await serversRes.json()).servers ?? []);
      if (usersRes.ok) {
        setUsers((await usersRes.json()).users ?? []);
        setUsersError(null);
      } else {
        // Previously ignored, which made the Access matrix silently vanish and
        // look like "there are no users" rather than "this request failed".
        setUsersError(await errorDetail(usersRes, "The user list could not be loaded."));
      }
    } catch (e) {
      setStatus({
        message: e instanceof Error ? e.message : "Could not load MCP servers.",
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [baseUrl, authHeaders, setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchServer = useCallback(
    async (server: McpServer, body: unknown, success?: string) => {
      const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return fail(r, "Could not update that integration.");
      await load();
      if (success) setStatus({ message: success, tone: "info" });
    },
    [baseUrl, authHeaders, fail, load, setStatus],
  );

  const add = async (server: NewServer): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await fetch(`${baseUrl}/admin/mcp/servers`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(server),
      });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not add that integration."));
      await load();
      setStatus({ message: "Integration added.", tone: "info" });
      return true;
    } catch (e) {
      setStatus({
        message: e instanceof Error ? e.message : "Could not add integration.",
        tone: "error",
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const actions: McpActions = useMemo(
    () => ({
      // Enabling is safe; disabling takes the integration away from every user.
      toggleServer: (server) => {
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
      },

      removeServer: (server) =>
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
        }),

      changeAvailability: (server, next) => {
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
      },

      saveSharedCredential: (server, credential) =>
        patchServer(
          server,
          { shared_credential: credential },
          `Shared token saved for ${server.name}.`,
        ),

      assignUser: (server, user, assigned) => {
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
      },

      setToolPolicy: (server, tool, change) => {
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
      },

      /**
       * Bulk enable/disable. Confirms once for the whole set rather than per
       * tool, and quotes the count and the server — the same blast-radius rule
       * the single-tool dialogs follow.
       */
      setToolsEnabled: (server, tools, enabled) => {
        const affected = tools.filter((t) => (t.enabled !== false) !== enabled);
        if (affected.length === 0) return;

        const apply = async () => {
          const results = await Promise.all(
            affected.map((tool) =>
              fetch(
                `${baseUrl}/admin/mcp/servers/${server.id}/tools/${encodeURIComponent(tool.name)}`,
                {
                  method: "PATCH",
                  headers: { ...authHeaders, "Content-Type": "application/json" },
                  body: JSON.stringify({ enabled }),
                },
              ),
            ),
          );
          await load();
          const failures = results.filter((r) => !r.ok).length;
          if (failures > 0) {
            // Partial success reported as such: the old panel's pattern of
            // reporting any failure as total failure hides work that did land.
            setStatus({
              message: `${affected.length - failures} of ${affected.length} tools updated; ${failures} failed.`,
              tone: "error",
            });
          } else {
            setStatus({
              message: `${affected.length} tool${affected.length === 1 ? "" : "s"} turned ${
                enabled ? "on" : "off"
              }.`,
              tone: "info",
            });
          }
        };

        if (!enabled) {
          setConfirm({
            title: `Turn off ${affected.length} tool${affected.length === 1 ? "" : "s"}?`,
            body: `Agents can no longer call ${affected.length} of ${server.name}'s tools. This applies to every user immediately.`,
            confirmLabel: "Turn off",
            onConfirm: apply,
          });
          return;
        }
        void apply();
      },
    }),
    [baseUrl, authHeaders, patchServer, fail, load, setStatus],
  );

  const toolCount = servers.reduce((sum, s) => sum + (s.tools?.length ?? 0), 0);
  const restricted = servers.filter((s) => s.availability === "selected").length;

  const tabs: SubTab<Tab>[] = [
    { id: "servers", label: "Servers", count: servers.length },
    { id: "access", label: "Access", count: restricted },
    { id: "tools", label: "Tools", count: toolCount },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubTabs tabs={tabs} value={tab} onChange={setTab} className="min-w-0 flex-1" />
        {!adding && (
          <Button
            variant="outlined"
            surface="panel"
            size="compact"
            onClick={() => setAdding(true)}
          >
            <span className="flex items-center gap-1.5">
              <Plus size={14} aria-hidden="true" />
              Add integration
            </span>
          </Button>
        )}
      </div>

      {adding && (
        <AddServerForm onSubmit={add} onCancel={() => setAdding(false)} saving={saving} />
      )}

      {tab === "servers" && (
        <ServersTab servers={servers} loading={loading} actions={actions} />
      )}
      {tab === "access" && (
        <AccessTab
          servers={servers}
          users={users}
          usersError={usersError}
          loading={loading}
          actions={actions}
        />
      )}
      {tab === "tools" && <ToolsTab servers={servers} loading={loading} actions={actions} />}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
