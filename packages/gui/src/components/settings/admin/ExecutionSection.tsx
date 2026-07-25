import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Badge,
  Banner,
  EmptyState,
  IconButton,
  Meter,
  RelativeTime,
  SettingsGroup,
  SettingsRow,
  Skeleton,
  Stat,
  StatGrid,
  formatCount,
  formatDuration,
  type BadgeTone,
} from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";
import { ExecutionTopology, type TopologyNode } from "./ExecutionTopology";

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

interface Admission {
  active_requests?: number;
  max_concurrent_requests?: number;
  queued_requests?: number;
  queued_users?: number;
  max_queued?: number;
  max_queued_per_user?: number;
  queue_timeout_seconds?: number;
  priority_aging_seconds?: number;
  oldest_queue_age_seconds?: number;
  admitted_requests_total?: number;
  rejected_requests_total?: number;
  timed_out_requests_total?: number;
  average_queue_wait_seconds?: number;
  active_by_user?: Record<string, number>;
  queued_by_user?: Record<string, number>;
}

/** How often the panel re-reads while visible. Fast enough to watch a queue drain. */
const POLL_MS = 5000;

/**
 * Human names for the six counters the auditor maintains. Machine keys used to
 * reach the screen via `key.replace(/_/g," ")`, which turns `denied_capabilities`
 * into "denied capabilities" — readable, but it also meant a renamed key silently
 * changed the UI label, and there was nowhere to say what a counter counts.
 */
const METRIC_LABELS: Record<string, { label: string; hint: string }> = {
  worker_starts: { label: "Worker starts", hint: "Sandbox workers launched" },
  worker_crashes: { label: "Worker crashes", hint: "Exited unexpectedly" },
  timeouts: { label: "Timeouts", hint: "Executions killed on time limit" },
  denied_capabilities: { label: "Denied capabilities", hint: "Blocked by policy" },
  cleanup_failures: { label: "Cleanup failures", hint: "Workspace not reclaimed" },
  promotion_conflicts: { label: "Promotion conflicts", hint: "Concurrent writes to one path" },
};

/** A counter above zero is worth noticing for these; the rest are routine. */
const CONCERNING = new Set(["worker_crashes", "cleanup_failures", "promotion_conflicts", "timeouts"]);

/**
 * One vocabulary for every health reading.
 *
 * The four health rows previously used three: "Available"/"Unavailable",
 * "ok"/"fail", "reachable"/"down". Worse, only the failing state got a badge —
 * a healthy reading was plain grey mono text, so "fine" and "not reported" looked
 * the same. Every state gets a tone here, including the good one.
 */
function StateBadge({ ok, good, bad }: { ok: boolean | undefined; good: string; bad: string }) {
  if (ok === undefined) {
    return (
      <Badge tone="neutral" uppercase>
        not reported
      </Badge>
    );
  }
  const tone: BadgeTone = ok ? "success" : "error";
  return (
    <Badge tone={tone} uppercase>
      {ok ? good : bad}
    </Badge>
  );
}

export function ExecutionSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [health, setHealth] = useState<ExecutionHealth | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown>>({});
  const [metricsSessions, setMetricsSessions] = useState(0);
  const [admission, setAdmission] = useState<Admission>({});
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Polling must not raise a status banner on every transient failure, and a
  // background refresh must not blank the panel it is refreshing.
  const firstLoad = useRef(true);

  const load = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      try {
        const r = await fetch(`${baseUrl}/admin/execution-health`, { headers: authHeaders });
        if (!r.ok) throw new Error(await errorDetail(r, "Could not load execution health."));
        const d = await r.json();
        setHealth(d.execution ?? null);
        setMetrics(d.metrics ?? {});
        setMetricsSessions(d.metrics_sessions ?? 0);
        setAdmission(d.admission ?? {});
        setFetchedAt(Date.now());
      } catch (e) {
        if (!background) {
          setStatus({
            message: e instanceof Error ? e.message : "Could not load execution health.",
            tone: "error",
          });
        }
      } finally {
        if (!background) setLoading(false);
        firstLoad.current = false;
      }
    },
    [baseUrl, authHeaders, setStatus],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while visible. A hidden tab polling an admin endpoint every five
  // seconds is pure server load for a reading nobody is looking at.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(true), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load(true);
        start();
      } else {
        stop();
      }
    };

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const refresh = (
    <IconButton label="Refresh execution health" onClick={() => void load()} disabled={loading}>
      <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
    </IconButton>
  );

  if (!health) {
    return (
      <SettingsGroup label="Execution" action={refresh}>
        {loading ? (
          <Skeleton.List rows={4} />
        ) : (
          <EmptyState
            size="sm"
            title="No execution health data"
            body="The server reported no execution backend. Nothing has run yet, or the backend failed to initialise."
          />
        )}
      </SettingsGroup>
    );
  }

  const active = admission.active_requests ?? 0;
  const maxActive = admission.max_concurrent_requests ?? 0;
  const queued = admission.queued_requests ?? 0;
  const maxQueued = admission.max_queued ?? 0;
  const oldest = admission.oldest_queue_age_seconds ?? 0;

  // Nodes read left to right along the request path, each carrying the one
  // number that tells you whether this hop is the constraint.
  const topology: TopologyNode[] = [
    {
      id: "queue",
      label: "Admission queue",
      value: maxQueued > 0 ? `${queued} / ${maxQueued}` : String(queued),
      detail: queued > 0 ? `oldest ${formatDuration(oldest)}` : "no waiting turns",
      tone: queued === 0 ? "ok" : maxQueued > 0 && queued / maxQueued > 0.9 ? "danger" : "warning",
      statusText: queued === 0 ? "empty" : `${queued} turns waiting`,
    },
    {
      id: "turns",
      label: "Agent turns",
      value: maxActive > 0 ? `${active} / ${maxActive}` : String(active),
      detail: active === 0 ? "idle" : "running now",
      tone: active === 0 ? "idle" : maxActive > 0 && active >= maxActive ? "warning" : "busy",
      statusText:
        active === 0
          ? "idle"
          : maxActive > 0 && active >= maxActive
            ? "at capacity"
            : `${active} running`,
    },
    {
      id: "sandbox",
      label: "Sandbox",
      value: health.backend || "unknown",
      detail: health.available ? "accepting work" : "unavailable",
      tone: health.available ? "ok" : "danger",
      statusText: health.available ? "available" : "unavailable",
    },
    {
      id: "isolation",
      label: "Isolation",
      value: health.isolation ? health.isolation_tier ?? "on" : "off",
      // The one place where "off" is the alarming state rather than the quiet one:
      // user code running unisolated is the single most important fact here.
      detail: health.isolation ? "user code contained" : "user code NOT contained",
      tone: health.isolation ? "ok" : "danger",
      statusText: health.isolation
        ? `enabled, tier ${health.isolation_tier ?? "unknown"}`
        : "disabled — user code is not contained",
    },
    {
      id: "worker",
      label: "Worker",
      value: health.worker_reachable ? "reachable" : "unreachable",
      detail: health.persistent_python ? "persistent Python up" : "no persistent Python",
      tone: health.worker_reachable ? "ok" : "danger",
      statusText: health.worker_reachable ? "reachable" : "unreachable",
    },
  ];

  const knownMetrics = Object.keys(METRIC_LABELS).filter((k) => k in metrics);
  // Anything the server reports that this build does not know about. Rendering
  // it rather than dropping it means a new counter appears the day it ships.
  const unknownScalars = Object.entries(metrics).filter(
    ([k, v]) =>
      !(k in METRIC_LABELS) &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
  );
  const nested = Object.entries(metrics).filter(([, v]) => v !== null && typeof v === "object");

  return (
    <>
      {health.error && <Banner tone="error" variant="inline" messages={[health.error]} />}
      {health.warnings?.length > 0 && (
        <Banner tone="warning" variant="inline" messages={health.warnings} />
      )}

      <SettingsGroup
        label="Sandbox"
        description="Where user code runs."
        action={refresh}
        footnote={
          fetchedAt ? (
            <RelativeTime epoch={fetchedAt} prefix="Updated" absolute />
          ) : undefined
        }
      >
        <SettingsRow
          label="Status"
          description={health.available ? undefined : "No execution requests can be served."}
          control={<StateBadge ok={health.available} good="available" bad="unavailable" />}
        />
        <SettingsRow
          label="Backend"
          control={<span className="font-mono text-caption text-scout-muted">{health.backend}</span>}
        />
        <SettingsRow
          label="Isolation"
          description={
            health.isolation
              ? `Tier: ${health.isolation_tier ?? "unspecified"}.`
              : "User code runs without a sandbox boundary."
          }
          control={
            <StateBadge
              ok={health.isolation}
              good={health.isolation_tier ?? "enabled"}
              bad="disabled"
            />
          }
        />
        <SettingsRow
          label="Persistent Python"
          description="A reused interpreter, so state survives between executions."
          control={<StateBadge ok={health.persistent_python} good="running" bad="unavailable" />}
        />
        <SettingsRow
          label="Worker"
          control={<StateBadge ok={health.worker_reachable} good="reachable" bad="unreachable" />}
        />
      </SettingsGroup>

      <SettingsGroup
        label="Request path"
        description="Each hop a turn passes through, and whether it is the constraint right now."
      >
        <ExecutionTopology nodes={topology} />
      </SettingsGroup>

      <SettingsGroup label="Capacity" description="Live load against the configured limits.">
        <div className="space-y-4 px-4 py-3.5">
          <Meter
            label="Running turns"
            value={active}
            max={maxActive}
            hint={
              maxActive > 0 && active >= maxActive
                ? "At capacity — new turns will queue."
                : "Turns executing concurrently."
            }
          />
          <Meter
            label="Queue depth"
            value={queued}
            max={maxQueued}
            hint={
              queued > 0
                ? `Oldest has waited ${formatDuration(oldest)}, across ${admission.queued_users ?? 0} user(s).`
                : "Nothing waiting."
            }
          />
        </div>
        <SettingsRow
          label="Per-user queue limit"
          description="How many turns one user may have waiting before further requests are rejected."
          control={
            <span className="font-mono text-caption text-scout-muted">
              {admission.max_queued_per_user ?? "—"}
            </span>
          }
        />
        <SettingsRow
          label="Queue timeout"
          description="How long a turn may wait before it is timed out."
          control={
            <span className="font-mono text-caption text-scout-muted">
              {admission.queue_timeout_seconds !== undefined
                ? formatDuration(admission.queue_timeout_seconds)
                : "—"}
            </span>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        label="Totals"
        description="Cumulative counters. These reset when the server restarts."
      >
        <div className="px-4 py-3.5">
          <StatGrid>
            <Stat
              label="Admitted"
              value={formatCount(admission.admitted_requests_total ?? 0)}
              hint="since start"
            />
            <Stat
              label="Rejected"
              value={formatCount(admission.rejected_requests_total ?? 0)}
              tone={(admission.rejected_requests_total ?? 0) > 0 ? "warning" : "neutral"}
              hint="queue was full"
            />
            <Stat
              label="Timed out"
              value={formatCount(admission.timed_out_requests_total ?? 0)}
              tone={(admission.timed_out_requests_total ?? 0) > 0 ? "warning" : "neutral"}
              hint="waited too long"
            />
            <Stat
              label="Average wait"
              value={formatDuration(admission.average_queue_wait_seconds ?? 0)}
              hint="admitted turns"
            />
          </StatGrid>
        </div>
      </SettingsGroup>

      {(knownMetrics.length > 0 || unknownScalars.length > 0 || nested.length > 0) && (
        <SettingsGroup
          label="Execution counters"
          description={
            metricsSessions > 0
              ? `Summed across ${metricsSessions} active session${metricsSessions === 1 ? "" : "s"}.`
              : "No active sessions are reporting counters."
          }
        >
          <div className="px-4 py-3.5">
            <StatGrid>
              {knownMetrics.map((key) => {
                const count = Number(metrics[key] ?? 0);
                return (
                  <Stat
                    key={key}
                    label={METRIC_LABELS[key].label}
                    value={formatCount(count)}
                    hint={METRIC_LABELS[key].hint}
                    tone={count > 0 && CONCERNING.has(key) ? "warning" : "neutral"}
                  />
                );
              })}
              {unknownScalars.map(([key, value]) => (
                <Stat key={key} label={key.replace(/_/g, " ")} value={String(value)} />
              ))}
            </StatGrid>
          </div>
          {nested.length > 0 && (
            <SettingsRow
              label="Nested counters"
              description="Reported by the worker but not summarised above."
            >
              <pre className="mt-2 max-h-64 overflow-auto rounded-control bg-scout-canvas p-2.5 font-mono text-micro leading-relaxed text-scout-muted">
                {JSON.stringify(Object.fromEntries(nested), null, 2)}
              </pre>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}
    </>
  );
}
