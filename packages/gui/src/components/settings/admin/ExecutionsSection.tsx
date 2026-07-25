import { useCallback, useEffect, useMemo, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import {
  Badge,
  Banner,
  Chip,
  DataTable,
  EmptyState,
  IconButton,
  RelativeTime,
  Segmented,
  SettingsGroup,
  Skeleton,
  Stat,
  TableSearch,
  StatGrid,
  formatDuration,
  type Column,
} from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";
import { ExecutionChart, bucketExecutions } from "./ExecutionChart";

interface ExecutionRow {
  execution_id: string;
  user_id: string;
  session_id: string;
  runtime: string;
  command_summary: string;
  start_time: number;
  end_time: number | null;
  duration_seconds: number | null;
  status: string;
  error_category: string | null;
  changed_paths: string[];
  approval_outcome: string | null;
}

/** Ranges and the bucket width that gives each one a readable number of bars. */
const RANGES = [
  { value: "1h", label: "1h", seconds: 3600, bucket: 120 },
  { value: "6h", label: "6h", seconds: 6 * 3600, bucket: 600 },
  { value: "24h", label: "24h", seconds: 24 * 3600, bucket: 1800 },
  { value: "7d", label: "7d", seconds: 7 * 86400, bucket: 6 * 3600 },
] as const;

type RangeKey = (typeof RANGES)[number]["value"];

/** Rows fetched per load. The endpoint caps this server-side at 500. */
const LIMIT = 300;

/**
 * The execution audit log.
 *
 * This is the one genuinely new admin surface. `execution_audit` has been
 * recording every execution — user, runtime, command, status, error category,
 * duration — with no reader at all: `ExecutionAuditor.recent()` had zero callers,
 * so a durable history of everything that ran was write-only.
 */
export function ExecutionsSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [rows, setRows] = useState<ExecutionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeKey>("24h");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "failed">("all");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const selected = RANGES.find((r) => r.value === range) ?? RANGES[2];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(
        `${baseUrl}/admin/executions?limit=${LIMIT}&since_seconds=${selected.seconds}`,
        { headers: authHeaders },
      );
      if (!r.ok) throw new Error(await errorDetail(r, "Could not load the execution log."));
      const d = await r.json();
      setRows(d.executions ?? []);
      setTotal(d.total ?? 0);
      setTruncated(Boolean(d.truncated));
    } catch (e) {
      setStatus({
        message: e instanceof Error ? e.message : "Could not load the execution log.",
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [baseUrl, authHeaders, setStatus, selected.seconds]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.error_category) set.add(r.error_category);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (statusFilter === "ok" && r.status !== "ok") return false;
        if (statusFilter === "failed" && r.status === "ok") return false;
        if (categoryFilter && r.error_category !== categoryFilter) return false;
        return true;
      }),
    [rows, statusFilter, categoryFilter],
  );

  // The chart plots the whole range, not the filtered subset: a failure-rate
  // line drawn over "failed only" would be a flat 100% and mean nothing.
  const points = useMemo(
    () => bucketExecutions(rows, selected.bucket, selected.seconds),
    [rows, selected],
  );

  const failed = rows.filter((r) => r.status !== "ok").length;
  const durations = rows.map((r) => r.duration_seconds).filter((d): d is number => d !== null);
  const median = useMemo(() => {
    if (durations.length === 0) return null;
    const sorted = [...durations].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [durations]);

  const columns: Column<ExecutionRow>[] = [
    {
      key: "when",
      header: "When",
      width: "minmax(78px,max-content)",
      sortValue: (r) => r.start_time,
      render: (r) => (
        <RelativeTime epoch={r.start_time} className="whitespace-nowrap text-scout-muted" />
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "max-content",
      sortValue: (r) => (r.status === "ok" ? 0 : 1),
      render: (r) =>
        r.status === "ok" ? (
          <Badge tone="success" uppercase>
            ok
          </Badge>
        ) : (
          <Badge tone="error" uppercase title={r.error_category ?? undefined}>
            {r.error_category ? r.error_category.replace(/_/g, " ") : r.status}
          </Badge>
        ),
    },
    {
      key: "user_id",
      header: "User",
      width: "minmax(52px,max-content)",
      sortValue: (r) => r.user_id,
      render: (r) => <span className="font-mono text-scout-muted">#{r.user_id}</span>,
    },
    {
      key: "runtime",
      header: "Runtime",
      width: "max-content",
      sortValue: (r) => r.runtime,
      render: (r) => <span className="font-mono text-scout-muted">{r.runtime}</span>,
    },
    {
      key: "command_summary",
      header: "Command",
      width: "minmax(160px,2fr)",
      searchValue: (r) =>
        `${r.command_summary} ${r.runtime} ${r.error_category ?? ""} ${r.session_id} ${r.user_id}`,
      render: (r) => (
        // The full text is on hover: summaries are truncated to 500 chars
        // server-side and would otherwise wrap a row to four lines.
        <span className="block truncate font-mono text-micro" title={r.command_summary}>
          {r.command_summary || "—"}
        </span>
      ),
    },
    {
      key: "duration",
      header: "Took",
      align: "right",
      width: "max-content",
      sortValue: (r) => r.duration_seconds ?? -1,
      render: (r) => (
        <span className="whitespace-nowrap font-mono tabular-nums text-scout-muted">
          {r.duration_seconds !== null ? formatDuration(r.duration_seconds) : "—"}
        </span>
      ),
    },
    {
      key: "changed",
      header: "Files",
      align: "right",
      width: "max-content",
      sortValue: (r) => r.changed_paths.length,
      render: (r) =>
        r.changed_paths.length > 0 ? (
          <span
            className="font-mono tabular-nums"
            title={r.changed_paths.slice(0, 20).join("\n")}
          >
            {r.changed_paths.length}
          </span>
        ) : (
          <span className="text-scout-muted">—</span>
        ),
    },
  ];

  return (
    <>
      {truncated && (
        <Banner
          tone="info"
          variant="inline"
          messages={[
            `Showing the most recent ${rows.length} of ${total} executions in this range. Earlier ones are in the log but not loaded, so the chart's oldest bars may undercount.`,
          ]}
        />
      )}

      <SettingsGroup
        label="Activity"
        description="Executions over time, from the durable audit log."
        action={
          <div className="flex items-center gap-2">
            <Segmented
              value={range}
              onChange={(next) => setRange(next as RangeKey)}
              label="Time range"
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
            <IconButton label="Refresh execution log" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </IconButton>
          </div>
        }
      >
        <div className="px-4 py-3.5">
          {loading ? (
            <Skeleton.Block className="h-[132px] w-full rounded-control" />
          ) : points.length === 0 ? (
            <EmptyState
              size="sm"
              title="Nothing ran in this range"
              body="Try a longer range, or run something and refresh."
            />
          ) : (
            <ExecutionChart points={points} bucketSeconds={selected.bucket} />
          )}
        </div>
        {!loading && rows.length > 0 && (
          <div className="px-4 py-3.5">
            <StatGrid>
              <Stat label="Executions" value={rows.length} hint={`in the last ${selected.label}`} />
              <Stat
                label="Failed"
                value={failed}
                tone={failed > 0 ? "warning" : "neutral"}
                hint={`${Math.round((failed / rows.length) * 100)}% of the range`}
              />
              <Stat
                label="Median duration"
                value={median !== null ? formatDuration(median) : "—"}
                hint="completed executions"
              />
              <Stat label="Recorded in total" value={total} hint="matching this range" />
            </StatGrid>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        label="Execution log"
        description="One row per execution. Commands are summarised by the server; arguments and secrets are not recorded."
        bare
      >
        <div className="space-y-2">
        {/* Search is its own surface. The filter chips stay inside the table's
            surface, because they act on the rows below them. */}
        <TableSearch value={query} onChange={setQuery} placeholder="Search commands" />
        <SettingsGroup>
        {/* Its own band with a closing hairline: with only `pt-3` the chips sat
            8px above the table's header rule, reading as stacked lines rather
            than two bands. */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-scout-hairline-faint px-4 pb-3 pt-3">
          <Chip pressed={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            All
          </Chip>
          <Chip
            pressed={statusFilter === "ok"}
            tone="success"
            onClick={() => setStatusFilter("ok")}
          >
            Succeeded
          </Chip>
          <Chip
            pressed={statusFilter === "failed"}
            tone="danger"
            onClick={() => setStatusFilter("failed")}
          >
            Failed
          </Chip>
          {categories.length > 0 && (
            <span className="mx-1 h-4 w-px bg-scout-hairline-faint" aria-hidden="true" />
          )}
          {categories.map((category) => (
            <Chip
              key={category}
              pressed={categoryFilter === category}
              tone="warning"
              // Pressing the active one clears it, so a filter is never a trap.
              onClick={() => setCategoryFilter(categoryFilter === category ? null : category)}
            >
              {category.replace(/_/g, " ")}
            </Chip>
          ))}
        </div>

        {loading ? (
          <div className="px-4 py-3">
            <Skeleton.List rows={6} />
          </div>
        ) : (
          <div className="py-2">
            <DataTable
              columns={columns}
              rows={filtered}
              getRowId={(r) => `${r.execution_id}:${r.start_time}`}
              query={query}
              initialSort={{ key: "when", dir: "desc" }}
              caption={
                filtered.length === rows.length
                  ? `${rows.length} execution${rows.length === 1 ? "" : "s"}`
                  : `${filtered.length} of ${rows.length} matching the active filters`
              }
              empty={
                <EmptyState
                  size="sm"
                  icon={<History size={20} />}
                  title={
                    rows.length === 0 ? "No executions recorded" : "Nothing matches these filters"
                  }
                  body={
                    rows.length === 0
                      ? `Nothing ran in the last ${selected.label}.`
                      : "Clear a filter chip above."
                  }
                />
              }
            />
          </div>
        )}
        </SettingsGroup>
        </div>
      </SettingsGroup>
    </>
  );
}
