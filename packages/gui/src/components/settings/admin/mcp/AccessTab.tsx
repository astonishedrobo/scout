import { useState } from "react";
import { Users } from "lucide-react";
import {
  Banner,
  Chip,
  DataTable,
  EmptyState,
  SettingsGroup,
  Skeleton,
  TableSearch,
  type Column,
} from "../../../ui";
import type { McpActions, McpServer, UserEntry } from "./types";

/**
 * Who may use which integration, as a users × servers matrix.
 *
 * This information existed but was close to unreachable: you had to expand a
 * server, and it only appeared at all when that server's availability happened to
 * be "selected" — so "who has access to what" could not be answered without
 * clicking through every server. Worse, the users fetch failure was swallowed, so
 * a failed request rendered as "no users to assign".
 *
 * Only servers set to "selected" have per-user assignment; a server available to
 * everyone has nothing to assign, so it is listed separately rather than shown as
 * a row of chips that cannot be pressed.
 */
export function AccessTab({
  servers,
  users,
  usersError,
  loading,
  actions,
}: {
  servers: McpServer[];
  users: UserEntry[];
  usersError: string | null;
  loading: boolean;
  actions: McpActions;
}) {
  const [query, setQuery] = useState("");
  const selective = servers.filter((s) => s.availability === "selected");
  const open = servers.filter((s) => s.availability !== "selected");

  if (loading) {
    return (
      <SettingsGroup label="Access">
        <div className="px-4 py-3">
          <Skeleton.List rows={4} />
        </div>
      </SettingsGroup>
    );
  }

  if (usersError) {
    return (
      <SettingsGroup label="Access">
        <EmptyState
          size="sm"
          title="Could not load users"
          body={`${usersError} Assignments cannot be shown or changed until this succeeds.`}
        />
      </SettingsGroup>
    );
  }

  const columns: Column<UserEntry>[] = [
    {
      key: "username",
      header: "User",
      width: "minmax(110px,1fr)",
      sortValue: (u) => u.username.toLowerCase(),
      searchValue: (u) => u.username,
      render: (u) => <span className="truncate font-medium">{u.username}</span>,
    },
    ...selective.map<Column<UserEntry>>((server) => ({
      key: server.id,
      header: server.name,
      width: "max-content",
      sortValue: (u) => ((server.assigned_user_ids?.includes(u.id) ?? false) ? 0 : 1),
      render: (u) => {
        const assigned = server.assigned_user_ids?.includes(u.id) ?? false;
        return (
          <Chip
            pressed={assigned}
            tone="success"
            onClick={() => actions.assignUser(server, u, !assigned)}
            label={`${assigned ? "Remove" : "Give"} ${u.username} access to ${server.name}`}
          >
            {assigned ? "allowed" : "no access"}
          </Chip>
        );
      },
    })),
  ];

  return (
    <>
      {open.length > 0 && (
        <Banner
          tone="info"
          variant="inline"
          messages={[
            `Available to everyone, so there is nothing to assign: ${open
              .map((s) => s.name)
              .join(", ")}. Set a server to “Selected users” on the Servers tab to control it here.`,
          ]}
        />
      )}

      <SettingsGroup
        label="Access"
        description="Which users may enable each restricted integration. Changes apply the next time they start a conversation."
        bare
      >
        {selective.length === 0 ? (
          <SettingsGroup>
            <EmptyState
              size="sm"
              icon={<Users size={20} />}
              title="No restricted integrations"
              body="Every installed server is available to everyone, so there are no per-user assignments to manage."
            />
          </SettingsGroup>
        ) : (
          <div className="space-y-2">
          <TableSearch value={query} onChange={setQuery} placeholder="Search users" />
          <SettingsGroup>
          <div className="py-2">
            <DataTable
              columns={columns}
              rows={users}
              getRowId={(u) => String(u.id)}
              query={query}
              initialSort={{ key: "username", dir: "asc" }}
              caption={`${users.length} user${users.length === 1 ? "" : "s"} · ${
                selective.length
              } restricted integration${selective.length === 1 ? "" : "s"}`}
              empty={<EmptyState size="sm" icon={<Users size={20} />} title="No users yet" />}
            />
          </div>
          </SettingsGroup>
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
