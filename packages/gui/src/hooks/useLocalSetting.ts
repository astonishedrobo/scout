import { useCallback, useEffect, useState } from "react";

/**
 * Device-local settings, kept in one namespaced object.
 *
 * The settings UI is being built ahead of the endpoints that will back it, so
 * some rows have nowhere on the server to write to yet. Rather than fake them
 * (a control that snaps back on reload reads as a bug) they persist here, and
 * their group carries a "Saved on this device" footnote so nothing claims to be
 * server-side.
 *
 * When an endpoint lands, only the read/write pair in the section changes — the
 * row markup does not.
 */
const STORE_KEY = "scout.settings";

type Store = Record<string, unknown>;

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

export function useLocalSetting<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readLocalSetting(key, fallback));

  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeStore({ ...readStore(), [key]: next });
    },
    [key],
  );

  // Two windows open on the same app should not disagree about a setting.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORE_KEY) return;
      setValue(readLocalSetting(key, fallback));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // `fallback` is a literal at every call site; re-subscribing on it would
    // churn the listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, set];
}
