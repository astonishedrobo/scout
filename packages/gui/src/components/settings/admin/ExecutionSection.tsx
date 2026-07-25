import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Banner, EmptyState, IconButton, SettingsGroup, SettingsRow } from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";

interface ExecutionHealth {
  available: boolean;
  backend: string;
  isolation: boolean;
  isolation_tier?: string | null;
  persistent_python?: boolean;
  oneshot?: boolean;
  worker_reachable?: boolean;
  warnings: string[];
  error?: string | null;
}

/** A stat as a row: mono value on the right, matching every other row. */
function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "success" | "error";
}) {
  return (
    <SettingsRow
      label={label}
      control={
        tone ? (
          <Badge tone={tone === "success" ? "success" : "error"}>{value}</Badge>
        ) : (
          <span className="font-mono text-caption text-scout-muted">{value}</span>
        )
      }
    />
  );
}

export function ExecutionSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [health, setHealth] = useState<ExecutionHealth | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown>>({});
  const [admission, setAdmission] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl}/admin/execution-health`, { headers: authHeaders });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not load execution health."));
      const d = await r.json();
      setHealth(d.execution ?? null);
      setMetrics(d.metrics ?? {});
      setAdmission(d.admission ?? {});
    } catch (e) {
      setStatus({
        message: e instanceof Error ? e.message : "Could not load execution health.",
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [baseUrl, authHeaders, setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const scalarMetrics = Object.entries(metrics).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  const hasNested = Object.values(metrics).some((v) => v !== null && typeof v === "object");

  if (!health) {
    return (
      <SettingsGroup label="Execution">
        <EmptyState
          size="sm"
          body={loading ? "Loading execution health…" : "No execution health data."}
        />
      </SettingsGroup>
    );
  }

  return (
    <>
      {health.error && <Banner tone="error" variant="inline" messages={[health.error]} />}
      {health.warnings?.length > 0 && (
        <Banner tone="warning" variant="inline" messages={health.warnings} />
      )}

      <SettingsGroup
        label="Sandbox"
        description="Where user code runs."
        action={
          <IconButton label="Refresh execution health" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </IconButton>
        }
      >
        <StatRow
          label="Status"
          value={health.available ? "Available" : "Unavailable"}
          tone={health.available ? "success" : "error"}
        />
        <StatRow label="Backend" value={health.backend} />
        <StatRow
          label="Isolation"
          value={
            health.isolation
              ? health.isolation_tier ?? "yes"
              : `disabled${health.isolation_tier ? ` (${health.isolation_tier})` : ""}`
          }
          tone={health.isolation ? undefined : "error"}
        />
        <StatRow
          label="Persistent Python"
          value={health.persistent_python ? "ok" : "fail"}
          tone={health.persistent_python ? "success" : "error"}
        />
        <StatRow
          label="Worker"
          value={health.worker_reachable ? "reachable" : "down"}
          tone={health.worker_reachable ? "success" : "error"}
        />
      </SettingsGroup>

      <SettingsGroup label="Agent turn capacity">
        <StatRow
          label="Active"
          value={`${admission.active_requests ?? 0} / ${admission.max_concurrent_requests ?? 0}`}
        />
        <StatRow label="Queued" value={admission.queued_requests ?? 0} />
        <StatRow label="Average wait" value={`${admission.average_queue_wait_seconds ?? 0}s`} />
        <StatRow
          label="Rejected / timed out"
          value={`${admission.rejected_requests_total ?? 0} / ${admission.timed_out_requests_total ?? 0}`}
        />
      </SettingsGroup>

      {scalarMetrics.length > 0 && (
        <SettingsGroup label="Metrics">
          {scalarMetrics.map(([key, value]) => (
            <StatRow key={key} label={key.replace(/_/g, " ")} value={String(value)} />
          ))}
          {hasNested && (
            <SettingsRow label="Raw metrics" description="Everything the worker reports.">
              <details className="mt-2">
                <summary className="cursor-pointer text-caption text-scout-muted hover:text-scout-text">
                  Show JSON
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto font-mono text-micro text-scout-muted">
                  {JSON.stringify(metrics, null, 2)}
                </pre>
              </details>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}
    </>
  );
}
