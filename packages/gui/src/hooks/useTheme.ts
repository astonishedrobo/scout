import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "soft" | "light";

/**
 * Theme is shared application-wide via a tiny external store rather than
 * per-component local state. Every `useTheme()` caller (sidebar toggle,
 * settings selector, …) subscribes to the SAME value, so toggling the
 * theme anywhere updates every consumer instantly.
 */

function readInitial(): Theme {
  const saved =
    typeof localStorage !== "undefined" ? localStorage.getItem("scout-theme") : null;
  // New users / no preference: soft gray (not pure black).
  return saved === "light" || saved === "soft" || saved === "dark" ? saved : "soft";
}

let currentTheme: Theme = readInitial();
const listeners = new Set<() => void>();

function readPreferredDarkTheme(): Exclude<Theme, "light"> {
  const saved =
    typeof localStorage !== "undefined" ? localStorage.getItem("scout-dark-theme") : null;
  if (saved === "dark" || saved === "soft") return saved;
  return "soft";
}

let preferredDarkTheme = readPreferredDarkTheme();

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "soft", "light");
  root.classList.add(theme);
  localStorage.setItem("scout-theme", theme);
}

// Make sure the DOM matches the stored value on first load.
applyTheme(currentTheme);

function setThemeInternal(theme: Theme) {
  if (theme === currentTheme) return;
  if (theme !== "light") {
    preferredDarkTheme = theme;
    localStorage.setItem("scout-dark-theme", theme);
  }
  currentTheme = theme;
  applyTheme(theme);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentTheme;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setTheme = useCallback((t: Theme) => setThemeInternal(t), []);
  const toggle = useCallback(
    () => setThemeInternal(currentTheme === "light" ? preferredDarkTheme : "light"),
    [],
  );

  return { theme, setTheme, toggle };
}
