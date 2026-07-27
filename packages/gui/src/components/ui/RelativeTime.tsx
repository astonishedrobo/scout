import { useSyncExternalStore } from "react";

/**
 * "as of 14:22 · 8s ago" — a reading's age, refreshed in place.
 *
 * The admin pages had no notion of freshness at all, so a value fetched once on
 * mount looked identical to a live one. That is the difference between a
 * dashboard and a screenshot.
 *
 * All instances share one interval rather than each holding a timer, so a page
 * with twenty audit rows still ticks once a second.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
// A monotonically increasing tick, not a timestamp: `useSyncExternalStore`
// requires a referentially stable snapshot, and a fresh Date would never settle.
let tick = 0;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (!timer) {
    timer = setInterval(() => {
      tick += 1;
      for (const listener of listeners) listener();
    }, 1000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Re-renders once a second. Use when a component displays an elapsed duration. */
export function useSecondTick(): number {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => 0,
  );
}

/** Compact elapsed form: 8s, 4m, 3h, 2d. Never "0s" — "just now" reads better. */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Duration, not age — for an execution's runtime or a session's idle time. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Accepts either epoch seconds or epoch milliseconds — the audit log stores
 * seconds while `Date.now()` gives milliseconds, and mixing them silently
 * yields dates in 1970 or the year 57000.
 */
function toMillis(epoch: number): number {
  return epoch > 1e11 ? epoch : epoch * 1000;
}

export function RelativeTime({
  epoch,
  prefix,
  /** Show the wall-clock time as well as the age. Off for dense table cells. */
  absolute = false,
  className = "",
}: {
  epoch: number | null | undefined;
  prefix?: string;
  absolute?: boolean;
  className?: string;
}) {
  useSecondTick();

  if (epoch == null || !Number.isFinite(epoch)) {
    return <span className={`text-scout-muted ${className}`}>—</span>;
  }

  const millis = toMillis(epoch);
  const date = new Date(millis);
  const age = formatAge((Date.now() - millis) / 1000);
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <span className={className}>
      <time dateTime={date.toISOString()} title={date.toLocaleString()}>
        {prefix && `${prefix} `}
        {absolute && (
          <>
            {clock}
            <span className="mx-1 text-scout-muted">·</span>
          </>
        )}
        {age}
      </time>
    </span>
  );
}
