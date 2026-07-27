import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export interface ExitingItem<T> {
  item: T;
  key: string;
  /** True while the item has left the source list but is still animating out. */
  exiting: boolean;
}

/**
 * Retains items that have just disappeared from a list, so they can animate out.
 *
 * A per-row `<Presence>` wrapper cannot do this: rows leave via a server round
 * trip and a refetch (see `useSessions.deleteSession`), so by the time the
 * component re-renders the item is simply gone from the array and React has
 * already unmounted it. This diffs the incoming list against the previous one
 * and keeps departed entries around for `exitMs`, re-inserting each at the
 * index it held when it left so a fading row does not jump position.
 *
 * Under reduced motion the list passes through untouched — no retention, no
 * delay.
 *
 * Note the returned `exiting` items are stale snapshots by definition; render
 * them as non-interactive (the caller should apply `pointer-events-none` along
 * with the exit class).
 */
export function useExitingItems<T>(
  items: T[],
  getKey: (item: T) => string,
  exitMs: number,
): ExitingItem<T>[] {
  const reducedMotion = usePrefersReducedMotion();
  // key -> { item, index } for rows currently animating out.
  const [leaving, setLeaving] = useState<Map<string, { item: T; index: number }>>(
    () => new Map(),
  );
  const prevRef = useRef<Array<{ key: string; item: T }>>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const current = items.map((item) => ({ key: getKey(item), item }));
  const currentKeys = new Set(current.map((entry) => entry.key));

  useEffect(() => {
    if (reducedMotion) {
      prevRef.current = current;
      return;
    }

    // Capture the departing rows AND the index each held in the outgoing list,
    // before prevRef is advanced — that index is what keeps a fading row from
    // jumping to the end of the list.
    const departed = prevRef.current
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => !currentKeys.has(entry.key));
    prevRef.current = current;

    if (departed.length === 0) return;

    setLeaving((existing) => {
      const next = new Map(existing);
      departed.forEach((entry) => {
        next.set(entry.key, { item: entry.item, index: entry.index });
      });
      return next;
    });

    departed.forEach((entry) => {
      const existingTimer = timersRef.current.get(entry.key);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(entry.key);
        setLeaving((existing) => {
          if (!existing.has(entry.key)) return existing;
          const next = new Map(existing);
          next.delete(entry.key);
          return next;
        });
      }, exitMs);
      timersRef.current.set(entry.key, timer);
    });
    // `current`/`currentKeys` are rebuilt every render; the effect is driven by
    // the identity of `items` itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, exitMs, reducedMotion]);

  // An item that comes back (re-added, or a refetch that restores it) must stop
  // animating out immediately rather than double-render.
  useEffect(() => {
    if (leaving.size === 0) return;
    const revived = [...leaving.keys()].filter((key) => currentKeys.has(key));
    if (revived.length === 0) return;
    revived.forEach((key) => {
      const timer = timersRef.current.get(key);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timersRef.current.delete(key);
      }
    });
    setLeaving((existing) => {
      const next = new Map(existing);
      revived.forEach((key) => next.delete(key));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, leaving]);

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    },
    [],
  );

  if (leaving.size === 0) {
    return current.map(({ item, key }) => ({ item, key, exiting: false }));
  }

  const result: ExitingItem<T>[] = current.map(({ item, key }) => ({
    item,
    key,
    exiting: false,
  }));

  // Re-insert each departing row at the index it held, clamped to the list.
  // Keys already present in `items` are skipped: a revived row is dropped from
  // `leaving` in an effect, which runs *after* this render, so without this
  // guard there would be one render emitting the same key twice.
  [...leaving.entries()]
    .filter(([key]) => !currentKeys.has(key))
    .sort((a, b) => a[1].index - b[1].index)
    .forEach(([key, { item, index }]) => {
      result.splice(Math.min(index, result.length), 0, { item, key, exiting: true });
    });

  return result;
}
