import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  RelativeTime,
  SettingsGroup,
  SettingsRow,
  Skeleton,
  type ConfirmRequest,
} from "../../ui";
import { CodeBlock } from "../../CodeBlock";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";
import { toYaml } from "./toYaml";

interface EffectiveConfig {
  config?: unknown;
  source?: string;
  config_path?: string | null;
  version?: string;
  reloaded_at?: number | null;
  applies_to?: string;
}

/** Machine values become sentences; an admin should not have to read an enum. */
const SOURCE_MEANING: Record<string, string> = {
  deployment_yaml: "A config.yaml supplied to this deployment.",
  defaults_and_global: "Built-in defaults, plus any global config on this machine.",
};

const APPLIES_MEANING: Record<string, string> = {
  new_conversations:
    "Conversations started after the last reload. Turns already running keep the settings they began with.",
};

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
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl}/admin/config/effective`, { headers: authHeaders });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not load configuration."));
      setInfo(await r.json());
    } catch (e) {
      setStatus({
        message: e instanceof Error ? e.message : "Could not load configuration.",
        tone: "error",
      });
    } finally {
      setLoading(false);
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

  const yaml = useMemo(() => (info ? toYaml(info.config) : ""), [info]);

  /**
   * Placeholder during the fetch. The old panel rendered "—" and "defaults" for
   * every metadata row while loading, which is exactly what a deployment with no
   * config file looks like — so a slow fetch read as a real answer.
   */
  const pending = <span className="text-caption text-scout-muted">Loading…</span>;
  const mono = (text: string) => (
    <span className="truncate font-mono text-caption text-scout-muted">{text}</span>
  );

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
          description={
            info?.source ? SOURCE_MEANING[info.source] ?? "Where these values came from." : undefined
          }
          control={loading ? pending : mono(info?.source ?? "unknown")}
        />
        <SettingsRow
          label="File"
          description={
            !loading && !info?.config_path
              ? "No config file is in use — these are built-in defaults."
              : undefined
          }
          control={loading ? pending : mono(info?.config_path ?? "none")}
        />
        <SettingsRow
          label="Version"
          description="The config schema version this file targets."
          control={loading ? pending : mono(info?.version ?? "unspecified")}
        />
        <SettingsRow
          label="Last reloaded"
          description="When the server last re-read the file from disk."
          control={
            loading ? (
              pending
            ) : info?.reloaded_at ? (
              <RelativeTime
                epoch={info.reloaded_at}
                absolute
                className="text-caption text-scout-muted"
              />
            ) : (
              <span className="text-caption text-scout-muted">Not since startup</span>
            )
          }
        />
        <SettingsRow
          label="Applies to"
          description={
            info?.applies_to
              ? APPLIES_MEANING[info.applies_to] ?? undefined
              : APPLIES_MEANING.new_conversations
          }
          control={
            loading ? pending : mono((info?.applies_to ?? "new_conversations").replace(/_/g, " "))
          }
        />
      </SettingsGroup>

      <SettingsGroup
        label="Effective values"
        description="As YAML, matching the file on disk. Secrets are redacted by the server."
      >
        {loading ? (
          <div className="px-4 py-3">
            <Skeleton.List rows={5} />
          </div>
        ) : yaml ? (
          <div className="px-4 py-2">
            <CodeBlock language="yaml">{yaml}</CodeBlock>
          </div>
        ) : (
          <EmptyState
            size="sm"
            title="No configuration values"
            body="The server reported an empty config, so every setting is at its built-in default."
          />
        )}
      </SettingsGroup>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
