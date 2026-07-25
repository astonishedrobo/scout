import { useCallback, useEffect, useState } from "react";
import { Banner, Button, ConfirmDialog, SettingsGroup, SettingsRow, type ConfirmRequest } from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";

interface EffectiveConfig {
  config?: unknown;
  source?: string;
  config_path?: string | null;
  version?: string;
  reloaded_at?: number | null;
  applies_to?: string;
}

/**
 * The deployment's effective configuration — read-only by design.
 *
 * `POST /config` is 403 in server mode for everyone, admins included, because
 * config.yaml belongs to the deployment rather than to any user. What an admin
 * *can* do is re-read it from disk (`POST /admin/config/reload`), so that is what
 * this offers instead of an editable form whose save could only fail.
 */
export function ConfigurationSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [info, setInfo] = useState<EffectiveConfig | null>(null);
  const [reloading, setReloading] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${baseUrl}/admin/config/effective`, { headers: authHeaders });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not load configuration."));
      setInfo(await r.json());
    } catch (e) {
      setStatus({
        message: e instanceof Error ? e.message : "Could not load configuration.",
        tone: "error",
      });
    }
  }, [baseUrl, authHeaders, setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = () =>
    setConfirm({
      title: "Reload configuration from disk?",
      body: "The server re-reads config.yaml and applies it to new conversations. In-flight turns keep the current settings.",
      confirmLabel: "Reload",
      onConfirm: async () => {
        setReloading(true);
        try {
          const r = await fetch(`${baseUrl}/admin/config/reload`, {
            method: "POST",
            headers: authHeaders,
          });
          if (!r.ok) throw new Error(await errorDetail(r, "Could not reload configuration."));
          await load();
          setStatus({ message: "Configuration reloaded.", tone: "info" });
        } catch (e) {
          setStatus({
            message: e instanceof Error ? e.message : "Could not reload configuration.",
            tone: "error",
          });
        } finally {
          setReloading(false);
        }
      },
    });

  return (
    <>
      <Banner
        tone="info"
        variant="inline"
        messages={[
          "Configuration is owned by the deployment and cannot be edited here. Change config.yaml on the server, then reload.",
        ]}
      />

      <SettingsGroup
        label="Deployment configuration"
        action={
          <Button
            variant="outlined"
            surface="panel"
            size="compact"
            onClick={reload}
            loading={reloading}
          >
            Reload from disk
          </Button>
        }
      >
        <SettingsRow
          label="Source"
          control={<span className="font-mono text-caption text-scout-muted">{info?.source ?? "—"}</span>}
        />
        <SettingsRow
          label="File"
          control={
            <span className="truncate font-mono text-caption text-scout-muted">
              {info?.config_path ?? "defaults"}
            </span>
          }
        />
        <SettingsRow
          label="Version"
          control={<span className="font-mono text-caption text-scout-muted">{info?.version ?? "—"}</span>}
        />
        <SettingsRow
          label="Applies to"
          control={
            <span className="font-mono text-caption text-scout-muted">
              {info?.applies_to ?? "new_conversations"}
            </span>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="Effective values" description="Secrets are redacted by the server.">
        <SettingsRow label="config.yaml">
          <pre className="mt-2 max-h-[50vh] overflow-auto font-mono text-micro leading-relaxed text-scout-muted">
            {info ? JSON.stringify(info.config, null, 2) : "Loading…"}
          </pre>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
