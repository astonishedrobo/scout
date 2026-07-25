import { useMemo } from "react";

/**
 * Executions over time: a stacked bar of succeeded vs failed, with a
 * failure-rate line.
 *
 * This is legitimate history, not a gauge pretending to have a past — the rows
 * come from the durable `execution_audit` table, one per execution. There is no
 * aggregated metric history anywhere in the server, so this is the only chart in
 * the admin area that can honestly show a trend.
 *
 * Hand-rolled SVG, no charting dependency. It draws two rectangles and a
 * polyline; a library would be more code shipped to the browser than the chart
 * it draws. Colours come from `--scout-*` so all three themes work with no
 * per-theme palette.
 */

export interface ChartPoint {
  /** Bucket start, epoch seconds. */
  start: number;
  ok: number;
  failed: number;
}

const HEIGHT = 132;
const PAD_TOP = 10;
const PAD_BOTTOM = 18;
const PLOT = HEIGHT - PAD_TOP - PAD_BOTTOM;

export function ExecutionChart({
  points,
  bucketSeconds,
}: {
  points: ChartPoint[];
  /** Bucket width, used for the axis labels and the "each bar covers" caption. */
  bucketSeconds: number;
}) {
  const peak = useMemo(
    () => Math.max(1, ...points.map((p) => p.ok + p.failed)),
    [points],
  );

  if (points.length === 0) return null;

  // A viewBox in bucket units keeps the maths readable: one x unit per bucket,
  // and the SVG scales to whatever width the panel gives it.
  const width = points.length;
  const barWidth = 0.72;

  const line = points
    .map((p, i) => {
      const total = p.ok + p.failed;
      const rate = total === 0 ? 0 : p.failed / total;
      const x = i + 0.5;
      const y = PAD_TOP + PLOT * (1 - rate);
      return `${x.toFixed(3)},${y.toFixed(2)}`;
    })
    .join(" ");

  const anyFailures = points.some((p) => p.failed > 0);
  const first = points[0];
  const last = points[points.length - 1];
  const clock = (epoch: number) =>
    new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const totalOk = points.reduce((sum, p) => sum + p.ok, 0);
  const totalFailed = points.reduce((sum, p) => sum + p.failed, 0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[132px] w-full"
        role="img"
        aria-label={`Executions over time: ${totalOk} succeeded and ${totalFailed} failed across ${points.length} buckets between ${clock(first.start)} and ${clock(last.start)}. Peak ${peak} in one bucket.`}
      >
        {/* Baseline. Without it an all-zero range looks like a rendering failure. */}
        <line
          x1={0}
          y1={PAD_TOP + PLOT}
          x2={width}
          y2={PAD_TOP + PLOT}
          stroke="rgb(var(--scout-hairline))"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) => {
          const okHeight = (p.ok / peak) * PLOT;
          const failHeight = (p.failed / peak) * PLOT;
          const x = i + (1 - barWidth) / 2;
          return (
            <g key={p.start}>
              <rect
                x={x}
                y={PAD_TOP + PLOT - okHeight}
                width={barWidth}
                height={okHeight}
                fill="rgb(var(--scout-success))"
                opacity={0.75}
              />
              <rect
                x={x}
                y={PAD_TOP + PLOT - okHeight - failHeight}
                width={barWidth}
                height={failHeight}
                fill="rgb(var(--scout-error))"
                opacity={0.85}
              />
            </g>
          );
        })}
        {anyFailures && (
          <polyline
            points={line}
            fill="none"
            stroke="rgb(var(--scout-error))"
            strokeWidth={1.25}
            strokeLinejoin="round"
            // Without this the stroke is stretched by the non-uniform scale and
            // renders as a wedge rather than a line.
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-micro text-scout-muted">
        <span className="font-mono tabular-nums">{clock(first.start)}</span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px] bg-scout-success/75" aria-hidden="true" />
            {totalOk} succeeded
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px] bg-scout-error/85" aria-hidden="true" />
            {totalFailed} failed
          </span>
          {anyFailures && (
            <span className="flex items-center gap-1.5">
              <span className="h-px w-3 bg-scout-error" aria-hidden="true" />
              failure rate
            </span>
          )}
        </span>
        <span className="font-mono tabular-nums">{clock(last.start)}</span>
      </div>
      <p className="mt-1 text-micro text-scout-muted/80">
        Peak {peak} in one bar · each bar covers{" "}
        {bucketSeconds >= 3600
          ? `${Math.round(bucketSeconds / 3600)}h`
          : bucketSeconds >= 60
            ? `${Math.round(bucketSeconds / 60)}m`
            : `${bucketSeconds}s`}
      </p>
    </div>
  );
}

/** Groups executions into fixed-width buckets spanning the whole range. */
export function bucketExecutions(
  rows: { start_time: number; status: string }[],
  bucketSeconds: number,
  rangeSeconds: number,
): ChartPoint[] {
  if (rows.length === 0) return [];
  const now = Date.now() / 1000;
  const from = now - rangeSeconds;
  const count = Math.max(1, Math.ceil(rangeSeconds / bucketSeconds));

  // Every bucket is emitted, including empty ones. Dropping them would compress
  // a quiet hour out of existence and make the gap invisible.
  const buckets: ChartPoint[] = Array.from({ length: count }, (_, i) => ({
    start: Math.round(from + i * bucketSeconds),
    ok: 0,
    failed: 0,
  }));

  for (const row of rows) {
    const index = Math.floor((row.start_time - from) / bucketSeconds);
    if (index < 0 || index >= count) continue;
    if (row.status === "ok") buckets[index].ok += 1;
    else buckets[index].failed += 1;
  }
  return buckets;
}
