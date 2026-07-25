import { useMemo, useState } from "react";
import { Wrench } from "lucide-react";
import {
  Badge,
  Button,
  Chip,
  DataTable,
  EmptyState,
  SettingsGroup,
  Skeleton,
  Switch,
  TableSearch,
  type Column,
} from "../../../ui";
import type { McpActions, McpServer, McpTool } from "./types";

interface ToolRow {
  key: string;
  server: McpServer;
  tool: McpTool;
}

/**
 * Every tool from every server, in one searchable table.
 *
 * Tool policy is the highest-consequence thing on this page — it decides what an
 * agent may do on a user's behalf — and it used to be buried in a `<details>`
 * inside a row inside a server. An admin auditing write access had to open every
 * server and read every list.
 */
export function ToolsTab({
  servers,
  loading,
  actions,
}: {
  servers: McpServer[];
  loading: boolean;
  actions: McpActions;
}) {
  const [serverFilter, setServerFilter] = useState<string | null>(null);
  const [writableOnly, setWritableOnly] = useState(false);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const out: ToolRow[] = [];
    for (const server of servers) {
      for (const tool of server.tools ?? []) {
        out.push({ key: `${server.id}:${tool.name}`, server, tool });
      }
    }
    return out;
  }, [servers]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (serverFilter && r.server.id !== serverFilter) return false;
        if (writableOnly && r.tool.read_only !== false) return false;
        return true;
      }),
    [rows, serverFilter, writableOnly],
  );

  const writable = rows.filter((r) => r.tool.read_only === false).length;
  const disabled = rows.filter((r) => r.tool.enabled === false).length;

  // Servers that connect but expose nothing rendered as complete silence before,
  // which is indistinguishable from a server that was never contacted.
  const emptyServers = servers.filter(
    (s) => (s.tools?.length ?? 0) === 0 && s.health?.status === "ok",
  );

  const columns: Column<ToolRow>[] = [
    {
      key: "tool",
      header: "Tool",
      width: "minmax(150px,1.6fr)",
      sortValue: (r) => r.tool.name,
      searchValue: (r) => `${r.tool.name} ${r.tool.description ?? ""} ${r.server.name}`,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-mono text-micro text-scout-text">{r.tool.name}</span>
          {r.tool.description && (
            <span className="block truncate text-micro text-scout-muted" title={r.tool.description}>
              {r.tool.description}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "server",
      header: "Integration",
      width: "minmax(90px,max-content)",
      sortValue: (r) => r.server.name,
      render: (r) => <span className="truncate text-scout-muted">{r.server.name}</span>,
    },
    {
      key: "policy",
      header: "Permission",
      width: "max-content",
      sortValue: (r) => (r.tool.read_only === false ? 0 : 1),
      render: (r) => {
        const writes = r.tool.read_only === false;
        return (
          <Chip
            pressed={writes}
            // Pressed means "may write", so the pressed tone is the dangerous
            // one. The old control gave both states the same neutral pill.
            tone="danger"
            onClick={() => actions.setToolPolicy(r.server, r.tool, { read_only: writes })}
            label={`${r.tool.name} is currently ${writes ? "read and write" : "read only"}. Press to change.`}
          >
            {writes ? "read + write" : "read only"}
          </Chip>
        );
      },
    },
    {
      key: "enabled",
      header: "On",
      align: "right",
      width: "max-content",
      sortValue: (r) => (r.tool.enabled === false ? 1 : 0),
      render: (r) => (
        <Switch
          checked={r.tool.enabled !== false}
          onChange={(next) => actions.setToolPolicy(r.server, r.tool, { enabled: next })}
          label={`Enable ${r.tool.name}`}
        />
      ),
    },
  ];

  if (loading) {
    return (
      <SettingsGroup label="Tools">
        <div className="px-4 py-3">
          <Skeleton.List rows={6} />
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      label="Tools"
      description="What agents may call through each integration. Write access lets a tool make changes without a separate approval."
      bare
    >
      <div className="space-y-2">
      {rows.length > 0 && (
        <TableSearch value={query} onChange={setQuery} placeholder="Search tools" />
      )}
      <SettingsGroup>
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Wrench size={20} />}
          title="No tools available"
          body={
            servers.length === 0
              ? "No integrations are installed yet."
              : emptyServers.length > 0
                ? `${emptyServers.map((s) => s.name).join(", ")} connected but exposed no tools.`
                : "No installed integration has reported its tools yet."
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-scout-hairline-faint px-4 pb-3 pt-3">
            <Chip pressed={!serverFilter && !writableOnly} onClick={() => {
              setServerFilter(null);
              setWritableOnly(false);
            }}>
              All {rows.length}
            </Chip>
            <Chip
              pressed={writableOnly}
              tone="danger"
              onClick={() => setWritableOnly(!writableOnly)}
            >
              Can write {writable}
            </Chip>
            {servers.length > 1 && (
              <span className="mx-1 h-4 w-px bg-scout-hairline-faint" aria-hidden="true" />
            )}
            {servers.length > 1 &&
              servers
                .filter((s) => (s.tools?.length ?? 0) > 0)
                .map((s) => (
                  <Chip
                    key={s.id}
                    pressed={serverFilter === s.id}
                    onClick={() => setServerFilter(serverFilter === s.id ? null : s.id)}
                  >
                    {s.name}
                  </Chip>
                ))}
          </div>

          {/* Bulk action, scoped to what is on screen — a global "disable all"
              button with no visible subject is how a whole workspace loses its
              tools by accident. */}
          {serverFilter && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
              <span className="text-caption text-scout-muted">
                {filtered.length} tool{filtered.length === 1 ? "" : "s"} from{" "}
                {servers.find((s) => s.id === serverFilter)?.name}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  surface="panel"
                  size="compact"
                  disabled={filtered.every((r) => r.tool.enabled !== false)}
                  onClick={() => {
                    const server = servers.find((s) => s.id === serverFilter);
                    if (server) {
                      actions.setToolsEnabled(
                        server,
                        filtered.map((r) => r.tool),
                        true,
                      );
                    }
                  }}
                >
                  Turn all on
                </Button>
                <Button
                  variant="ghost"
                  surface="panel"
                  size="compact"
                  disabled={filtered.every((r) => r.tool.enabled === false)}
                  onClick={() => {
                    const server = servers.find((s) => s.id === serverFilter);
                    if (server) {
                      actions.setToolsEnabled(
                        server,
                        filtered.map((r) => r.tool),
                        false,
                      );
                    }
                  }}
                >
                  Turn all off
                </Button>
              </div>
            </div>
          )}

          <div className="py-2">
            <DataTable
              columns={columns}
              rows={filtered}
              getRowId={(r) => r.key}
              query={query}
              initialSort={{ key: "tool", dir: "asc" }}
              caption={
                <>
                  {rows.length} tool{rows.length === 1 ? "" : "s"} ·{" "}
                  {writable > 0 ? (
                    <Badge tone="warning">{writable} can write</Badge>
                  ) : (
                    "all read only"
                  )}
                  {disabled > 0 && ` · ${disabled} turned off`}
                </>
              }
              empty={
                <EmptyState size="sm" icon={<Wrench size={20} />} title="No tools match" />
              }
            />
          </div>

          {emptyServers.length > 0 && (
            <p className="px-4 pb-3 pt-1 text-micro text-scout-muted">
              Connected but exposing no tools: {emptyServers.map((s) => s.name).join(", ")}.
            </p>
          )}
        </>
      )}
      </SettingsGroup>
      </div>
    </SettingsGroup>
  );
}
