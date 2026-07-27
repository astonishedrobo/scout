import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, MonitorPlay, Users } from "lucide-react";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Meter,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  Skeleton,
  TableSearch,
  Stat,
  StatGrid,
  formatDuration,
  type Column,
  type ConfirmRequest,
} from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";

interface UserEntry {
  id: number;
  username: string;
  is_admin: boolean;
  permission_profile: string;
  admission_group: string;
}

interface PriorityGroup {
  priority: number;
  max_concurrent_requests_per_user: number;
}

interface LiveSession {
  user_id: string;
  session_id: string;
  model: string;
  age_seconds: number;
  idle_seconds: number;
  is_busy: boolean;
  subscribers: number;
  pending_approval: boolean;
}

const PROFILES = ["analyst", "contributor", "admin"] as const;

// Ordered so a downgrade can be recognised — it takes capability away from a
// real person, and used to apply on a select change with no confirmation.
const PROFILE_RANK: Record<string, number> = { analyst: 0, contributor: 1, admin: 2 };

/**
 * What each profile actually grants. The panel used to render the bare enum
 * string, which tells an admin the name of the setting but not its consequence —
 * the one thing they need before changing someone's access.
 */
const PROFILE_MEANING: Record<string, string> = {
  analyst: "Read and analyse. No workspace writes, no network egress.",
  contributor: "Read, write and run code in their workspace.",
  admin: "Everything a contributor can do, plus these admin settings.",
};

/**
 * One displayed role per user.
 *
 * `is_admin` and `permission_profile` are separate fields that can disagree, and
 * the old row rendered both at once — an "Admin" badge beside a select reading
 * `contributor`. That is not a display quirk; it is two sources of truth for
 * whether someone is an admin, and an admin needs to know it is happening rather
 * than see a UI quietly pick one. The profile is what the select edits, so the
 * profile is what is shown, and the disagreement is flagged.
 */
function roleOf(user: UserEntry): { profile: string; conflicted: boolean } {
  const profile = user.permission_profile ?? (user.is_admin ? "admin" : "contributor");
  return { profile, conflicted: user.is_admin !== (profile === "admin") };
}

export function UsersSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [groups, setGroups] = useState<Record<string, PriorityGroup>>({});
  const [activeByUser, setActiveByUser] = useState<Record<string, number>>({});
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userQuery, setUserQuery] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Which rows have a request in flight, so the change disables only its own
  // row instead of the previous full-list refetch flashing every row at once.
  const [pending, setPending] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl}/admin/users`, { headers: authHeaders });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not load users."));
      const d = await r.json();
      setUsers(d.users ?? []);
      setGroups(d.priority_groups ?? {});
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not load users.", tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [baseUrl, authHeaders, setStatus]);

  /**
   * Live load, fetched separately from the user list because it changes on a
   * different timescale and a failure here must not hide the user table.
   */
  const loadLive = useCallback(async () => {
    try {
      const [healthRes, sessionRes] = await Promise.all([
        fetch(`${baseUrl}/admin/execution-health`, { headers: authHeaders }),
        fetch(`${baseUrl}/admin/sessions`, { headers: authHeaders }),
      ]);
      if (healthRes.ok) {
        const d = await healthRes.json();
        setActiveByUser(d.admission?.active_by_user ?? {});
      }
      if (sessionRes.ok) {
        const d = await sessionRes.json();
        setSessions(d.sessions ?? []);
        setSessionsError(null);
      } else {
        setSessionsError(await errorDetail(sessionRes, "Could not load live sessions."));
      }
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Could not load live sessions.");
    }
  }, [baseUrl, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadLive();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadLive();
    }, 8000);
    return () => clearInterval(timer);
  }, [loadLive]);

  /**
   * Applies a change optimistically, rolling the row back if the server refuses.
   * The old flow awaited a full `load()` on every select change, so a one-field
   * edit re-rendered the entire list.
   */
  const patch = async (
    user: UserEntry,
    path: string,
    body: Record<string, unknown>,
    optimistic: Partial<UserEntry>,
    success: string,
  ) => {
    const before = user;
    setPending((p) => ({ ...p, [user.id]: true }));
    setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, ...optimistic } : u)));
    try {
      const r = await fetch(`${baseUrl}${path}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setUsers((list) => list.map((u) => (u.id === before.id ? before : u)));
        setStatus({ message: await errorDetail(r, "Could not apply that change."), tone: "error" });
        return;
      }
      setStatus({ message: success, tone: "info" });
    } catch (e) {
      setUsers((list) => list.map((u) => (u.id === before.id ? before : u)));
      setStatus({
        message: e instanceof Error ? e.message : "Could not apply that change.",
        tone: "error",
      });
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[user.id];
        return next;
      });
    }
  };

  const changeProfile = (user: UserEntry, profile: string) => {
    const current = roleOf(user).profile;
    if (profile === current) return;
    const apply = () =>
      patch(
        user,
        `/admin/users/${user.id}/profile`,
        { permission_profile: profile },
        { permission_profile: profile, is_admin: profile === "admin" },
        `${user.username} is now ${profile}.`,
      );
    if ((PROFILE_RANK[profile] ?? 0) < (PROFILE_RANK[current] ?? 0)) {
      setConfirm({
        title: `Reduce ${user.username} to ${profile}?`,
        body: `${user.username} loses the permissions that come with "${current}" the next time they act.`,
        confirmLabel: "Reduce access",
        onConfirm: apply,
      });
      return;
    }
    void apply();
  };

  const changeGroup = (user: UserEntry, group: string) => {
    const current = user.admission_group || "standard";
    if (group === current) return;
    const currentCap = groups[current]?.max_concurrent_requests_per_user ?? 0;
    const nextCap = groups[group]?.max_concurrent_requests_per_user ?? 0;
    const apply = () =>
      patch(
        user,
        `/admin/users/${user.id}/admission-group`,
        { admission_group: group },
        { admission_group: group },
        `${user.username} moved to ${group}.`,
      );
    if (nextCap < currentCap) {
      setConfirm({
        title: `Move ${user.username} to ${group}?`,
        body: `Their concurrent turn limit drops from ${currentCap} to ${nextCap}.`,
        confirmLabel: "Change capacity",
        onConfirm: apply,
      });
      return;
    }
    void apply();
  };

  const groupOptions = Object.keys(groups).length
    ? Object.entries(groups).map(([name, g]) => ({
        value: name,
        label: name,
        description: `${g.max_concurrent_requests_per_user} concurrent turns`,
      }))
    : [{ value: "standard", label: "standard" }];

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of users) {
      const key = u.admission_group || "standard";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [users]);

  const capFor = (user: UserEntry) =>
    groups[user.admission_group || "standard"]?.max_concurrent_requests_per_user ?? 0;

  const columns: Column<UserEntry>[] = [
    {
      key: "username",
      header: "User",
      width: "minmax(120px,1.4fr)",
      sortValue: (u) => u.username.toLowerCase(),
      searchValue: (u) => `${u.username} ${u.permission_profile} ${u.admission_group}`,
      render: (u) => {
        const { conflicted } = roleOf(u);
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{u.username}</span>
            {conflicted && (
              // Deliberately a labelled badge, not an icon with a tooltip: the
              // tooltip is presentation-only, so an icon-only trigger would make
              // this invisible to a screen reader — and this is a warning.
              <Badge
                tone="warning"
                uppercase
                className="gap-1"
                title={`The is_admin flag and the "${roleOf(u).profile}" profile disagree for this user. The profile shown is what takes effect; saving it again reconciles them.`}
              >
                <AlertTriangle size={10} aria-hidden="true" />
                role mismatch
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: "profile",
      header: "Access",
      width: "minmax(130px,max-content)",
      sortValue: (u) => PROFILE_RANK[roleOf(u).profile] ?? 0,
      render: (u) => (
        <SettingsSelect
          value={roleOf(u).profile}
          onChange={(next) => changeProfile(u, next)}
          label={`Access level for ${u.username}`}
          disabled={pending[u.id]}
          options={PROFILES.map((p) => ({
            value: p,
            label: p,
            description: PROFILE_MEANING[p],
          }))}
        />
      ),
    },
    {
      key: "group",
      header: "Capacity group",
      width: "minmax(130px,max-content)",
      sortValue: (u) => u.admission_group || "standard",
      render: (u) => (
        <SettingsSelect
          value={u.admission_group || "standard"}
          onChange={(next) => changeGroup(u, next)}
          label={`Capacity group for ${u.username}`}
          disabled={pending[u.id]}
          options={groupOptions}
        />
      ),
    },
    {
      key: "usage",
      header: "In use",
      width: "minmax(90px,0.8fr)",
      sortValue: (u) => activeByUser[String(u.id)] ?? 0,
      render: (u) => {
        const running = activeByUser[String(u.id)] ?? 0;
        const cap = capFor(u);
        // A meter for everyone would be fourteen empty bars. Only a user who is
        // actually running something has a level worth drawing.
        if (running === 0) return <span className="text-scout-muted">idle</span>;
        return <Meter label="" value={running} max={cap} className="min-w-[70px]" />;
      },
    },
  ];

  const admins = users.filter((u) => roleOf(u).profile === "admin").length;

  const busySessions = sessions.filter((s) => s.is_busy).length;

  const sessionColumns: Column<LiveSession>[] = [
    {
      key: "user",
      header: "User",
      sortValue: (s) => s.user_id,
      searchValue: (s) => {
        const owner = users.find((u) => String(u.id) === s.user_id);
        return `${owner?.username ?? s.user_id} ${s.session_id} ${s.model}`;
      },
      render: (s) => {
        // Sessions carry a user id; the admin knows people by name.
        const owner = users.find((u) => String(u.id) === s.user_id);
        return <span className="truncate font-medium">{owner?.username ?? `#${s.user_id}`}</span>;
      },
    },
    {
      key: "state",
      header: "State",
      width: "max-content",
      sortValue: (s) => (s.is_busy ? 0 : 1),
      render: (s) =>
        s.pending_approval ? (
          <Badge tone="warning" uppercase>
            awaiting approval
          </Badge>
        ) : s.is_busy ? (
          <Badge tone="info" uppercase>
            working
          </Badge>
        ) : (
          <Badge tone="neutral" uppercase>
            idle
          </Badge>
        ),
    },
    {
      key: "idle",
      header: "Last activity",
      align: "right",
      width: "max-content",
      sortValue: (s) => s.idle_seconds,
      render: (s) => (
        <span className="font-mono tabular-nums text-scout-muted">
          {formatDuration(s.idle_seconds)} ago
        </span>
      ),
    },
    {
      key: "age",
      header: "Open for",
      align: "right",
      width: "max-content",
      sortValue: (s) => s.age_seconds,
      render: (s) => (
        <span className="font-mono tabular-nums text-scout-muted">
          {formatDuration(s.age_seconds)}
        </span>
      ),
    },
    {
      key: "subscribers",
      header: "Clients",
      align: "right",
      width: "max-content",
      sortValue: (s) => s.subscribers,
      render: (s) => <span className="font-mono tabular-nums">{s.subscribers}</span>,
    },
  ];

  return (
    <>
      {Object.keys(groups).length > 0 && (
        <SettingsGroup
          label="Capacity groups"
          description="Each group's queue priority and per-user concurrency limit."
        >
          <div className="px-4 py-3.5">
            <StatGrid>
              {Object.entries(groups)
                .sort((a, b) => b[1].priority - a[1].priority)
                .map(([name, g]) => (
                  <Stat
                    key={name}
                    label={name}
                    value={g.max_concurrent_requests_per_user}
                    unit="turns each"
                    hint={`priority ${g.priority} · ${groupCounts[name] ?? 0} user${
                      (groupCounts[name] ?? 0) === 1 ? "" : "s"
                    }`}
                  />
                ))}
            </StatGrid>
          </div>
          <SettingsRow
            label="How priority is used"
            description="Higher priority is served first when turns are queued. Waiting also raises a turn's effective priority over time, so a lower-priority user cannot be starved indefinitely."
          />
        </SettingsGroup>
      )}

      <SettingsGroup
        label="Users"
        description="Access level and turn capacity, per person. Changes apply the next time they act."
        bare
      >
        {loading ? (
          <SettingsGroup>
            <div className="px-4 py-3">
              <Skeleton.List rows={4} />
            </div>
          </SettingsGroup>
        ) : (
          <div className="space-y-2">
            <TableSearch value={userQuery} onChange={setUserQuery} placeholder="Search users" />
            <SettingsGroup>
              <div className="py-2">
                <DataTable
                  columns={columns}
                  rows={users}
                  getRowId={(u) => String(u.id)}
                  query={userQuery}
                  initialSort={{ key: "username", dir: "asc" }}
                  caption={`${users.length} user${users.length === 1 ? "" : "s"} · ${admins} admin${
                    admins === 1 ? "" : "s"
                  }`}
                  empty={<EmptyState size="sm" icon={<Users size={20} />} title="No users yet" />}
                />
              </div>
            </SettingsGroup>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        label="Live sessions"
        description="Conversations open on the server right now."
        footnote={
          sessionsError
            ? undefined
            : `${sessions.length} open · ${busySessions} working. Refreshes every 8 seconds.`
        }
        bare
      >
        {sessionsError ? (
          <SettingsGroup>
            <EmptyState
              size="sm"
              title="Could not load live sessions"
              body={sessionsError}
            />
          </SettingsGroup>
        ) : (
          <div className="space-y-2">
            {sessions.length > 0 && (
              <TableSearch
                value={sessionQuery}
                onChange={setSessionQuery}
                placeholder="Search sessions"
              />
            )}
            <SettingsGroup>
              <div className="py-2">
                <DataTable
                  columns={sessionColumns}
                  rows={sessions}
                  getRowId={(s) => `${s.user_id}:${s.session_id}`}
                  query={sessionQuery}
                  initialSort={{ key: "idle", dir: "asc" }}
                  empty={
                    <EmptyState
                      size="sm"
                      icon={<MonitorPlay size={20} />}
                      title="No open sessions"
                      body="Nobody has a conversation open."
                    />
                  }
                />
              </div>
            </SettingsGroup>
          </div>
        )}
      </SettingsGroup>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
