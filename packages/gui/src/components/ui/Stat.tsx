import type { ReactNode } from "react";

/**
 * One number, one label. `StatGrid` lays a set of them out.
 *
 * This exists to make a specific mistake impossible. The execution panel used
 * to render `label="Rejected / timed out"` with the two counters joined into one
 * string, so neither number could be read on its own. A tile holds exactly one
 * value; two counters need two tiles.
 *
 * Draws no border or fill of its own — `SettingsGroup` still owns those.
 */
export type StatTone = "neutral" | "success" | "error" | "warning" | "info";

const tones: Record<StatTone, string> = {
  neutral: "text-scout-text",
  success: "text-scout-success",
  error: "text-scout-error",
  warning: "text-scout-warning",
  info: "text-scout-lavender",
};

export function Stat({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  /** Rendered smaller and muted beside the value — "s", "ms", "%". */
  unit?: string;
  /** One short line of qualification. Say "since start" for cumulative counters. */
  hint?: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="truncate text-micro font-medium uppercase tracking-[0.06em] text-scout-muted">
        {label}
      </p>
      <p className={`mt-1 flex items-baseline gap-1 text-prose font-mono tabular-nums ${tones[tone]}`}>
        <span className="truncate">{value}</span>
        {unit && <span className="text-caption font-sans text-scout-muted">{unit}</span>}
      </p>
      {hint && <p className="mt-0.5 text-micro leading-relaxed text-scout-muted">{hint}</p>}
    </div>
  );
}

/**
 * Responsive tile layout. Two columns on a phone so a stat is never a
 * full-width row of mostly whitespace, up to four on a wide panel.
 */
export function StatGrid({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 ${className}`}>
      {children}
    </div>
  );
}

/** Thousands separators, so a five-figure counter is legible at a glance. */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}
