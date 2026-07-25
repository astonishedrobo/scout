import type { ReactNode } from "react";

/**
 * A utilisation bar with a `n / max` readout.
 *
 * Use this only where a real denominator exists. The admin pages previously
 * rendered `"7 / 10"` as plain text, which is a number you have to reason about
 * rather than a level you can see. A cumulative counter has no maximum and
 * belongs in `Stat`, not here.
 *
 * The bar is decoration: the reading is the text beside it, and
 * `role="progressbar"` carries the same values for assistive technology. Tone
 * derives from utilisation unless the caller overrides it, so the thresholds
 * stay consistent across every meter in the app.
 */
export type MeterTone = "ok" | "warning" | "danger" | "neutral";

const fills: Record<MeterTone, string> = {
  ok: "bg-scout-success",
  warning: "bg-scout-warning",
  danger: "bg-scout-error",
  neutral: "bg-scout-muted",
};

const readouts: Record<MeterTone, string> = {
  ok: "text-scout-text",
  warning: "text-scout-warning",
  danger: "text-scout-error",
  neutral: "text-scout-muted",
};

/** Shared thresholds: below 70% is fine, 70–90% is worth watching, above is not. */
export function meterTone(value: number, max: number): MeterTone {
  if (max <= 0) return "neutral";
  const ratio = value / max;
  if (ratio > 0.9) return "danger";
  if (ratio >= 0.7) return "warning";
  return "ok";
}

export function Meter({
  label,
  value,
  max,
  hint,
  tone,
  unit,
  className = "",
}: {
  label: ReactNode;
  value: number;
  /** The real capacity. A non-positive max renders an unknown-denominator state. */
  max: number;
  /** One line of context under the bar — queue age, oldest waiter, and so on. */
  hint?: ReactNode;
  tone?: MeterTone;
  unit?: string;
  className?: string;
}) {
  const known = Number.isFinite(max) && max > 0;
  const resolved = tone ?? (known ? meterTone(value, max) : "neutral");
  // Clamp only the drawn width; the readout always shows the true numbers, so
  // an over-capacity reading stays visible instead of looking merely full.
  const percent = known ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const readout = known ? `${value} / ${max}` : `${value}`;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-caption font-medium text-scout-text">{label}</span>
        <span className={`text-caption font-mono tabular-nums ${readouts[resolved]}`}>
          {readout}
          {unit && <span className="ml-1 text-scout-muted">{unit}</span>}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuenow={value}
        aria-valuemin={0}
        {...(known ? { "aria-valuemax": max } : {})}
        aria-valuetext={known ? `${value} of ${max}` : `${value}, capacity unknown`}
        className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-scout-lift"
      >
        <div
          className={`h-full rounded-pill transition-[width] duration-panel ease-out ${fills[resolved]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {hint && <p className="mt-1.5 text-micro leading-relaxed text-scout-muted">{hint}</p>}
      {!known && (
        <p className="mt-1.5 text-micro leading-relaxed text-scout-muted">
          No configured limit reported.
        </p>
      )}
    </div>
  );
}
