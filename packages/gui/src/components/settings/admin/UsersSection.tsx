import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  Skeleton,
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

const PROFILES = ["analyst", "contributor", "admin"] as const;

// Ordered so a downgrade can be recognised — it takes capability away from a
// real person, and used to apply on a select change with no confirmation.
const PROFILE_RANK: Record<string, number> = { analyst: 0, contributor: 1, admin: 2 };

export function UsersSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [groups, setGroups] = useState<Record<string, PriorityGroup>>({});
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (path: string, body: unknown, success: string) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setStatus({ message: await errorDetail(r, "Could not apply that change."), tone: "error" });
      return;
    }
    await load();
    setStatus({ message: success, tone: "info" });
  };

  const changeProfile = (user: UserEntry, profile: string) => {
    const current = user.permission_profile ?? (user.is_admin ? "admin" : "contributor");
    if (profile === current) return;
    const apply = () =>
      patch(
        `/admin/users/${user.id}/profile`,
        { permission_profile: profile },
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
        `/admin/users/${user.id}/admission-group`,
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

  return (
    <>
      <SettingsGroup
        label="Users"
        description="Access level and turn capacity, per person. Changes apply the next time they act."
      >
        {loading ? (
          <div className="px-4 py-3">
            <Skeleton.List rows={4} />
          </div>
        ) : users.length === 0 ? (
          <EmptyState size="sm" icon={<Users size={20} />} title="No users yet" />
        ) : (
          users.map((user) => (
            <SettingsRow
              key={user.id}
              label={
                <span className="flex items-center gap-2">
                  {user.username}
                  {user.is_admin && <Badge tone="info">Admin</Badge>}
                </span>
              }
              description={`#${user.id}`}
              control={
                <>
                  <SettingsSelect
                    value={user.permission_profile ?? (user.is_admin ? "admin" : "contributor")}
                    onChange={(next) => changeProfile(user, next)}
                    label={`Access level for ${user.username}`}
                    options={PROFILES.map((p) => ({ value: p, label: p }))}
                  />
                  <SettingsSelect
                    value={user.admission_group || "standard"}
                    onChange={(next) => changeGroup(user, next)}
                    label={`Capacity group for ${user.username}`}
                    options={groupOptions}
                  />
                </>
              }
            />
          ))
        )}
      </SettingsGroup>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
