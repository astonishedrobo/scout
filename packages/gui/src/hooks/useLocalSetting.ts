import { useCallback, useSyncExternalStore } from "react";

/**
 * Device-local settings, kept in one namespaced object.
 *
 * Some rows in the settings UI have nowhere on the server to write to. Rather
 * than fake them (a control that snaps back on reload reads as a bug) they
 * persist here, and their group carries a "Saved on this device" footnote so
 * nothing claims to be server-side.
 *
 * Writes publish to a module-level listener set, so anything deriving state from
 * a setting — `usePrefersReducedMotion`, the density attribute — updates in the
 * same tab and not only in the next one.
 */
const STORE_KEY = "scout.settings";

type Store = Record<string, unknown>;

const listeners = new Set<() => void>();

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written key must not take the panel down.
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(next: Store) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode / quota-exceeded: the value still applies for this session.
  }
}

export function readLocalSetting<T>(key: string, fallback: T): T {
  const value = readStore()[key];
  return value === undefined ? fallback : (value as T);
}

/** Persists one setting and notifies every listener in this tab. */
export function writeLocalSetting<T>(key: string, value: T) {
  writeStore({ ...readStore(), [key]: value });
  for (const listener of listeners) listener();
}

/** Fires on any settings write, in this tab or another one. */
export function subscribeLocalSettings(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

// Two windows open on the same app should not disagree about a setting.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORE_KEY) return;
    for (const listener of listeners) listener();
  });
}

export function useLocalSetting<T>(key: string, fallback: T): [T, (next: T) => void] {
  // Read through the store on every publish, so two controls bound to the same
  // key agree without either of them owning the value.
  const value = useSyncExternalStore(
    subscribeLocalSettings,
    () => readLocalSetting(key, fallback),
    () => fallback,
  );

  const set = useCallback((next: T) => writeLocalSetting(key, next), [key]);

  return [value, set];
}
