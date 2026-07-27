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

/*
 * Crossfade bookkeeping. `.theme-switching` enables a colour-only transition on
 * every element (see globals.css) and MUST be transient — the `*` selector is
 * expensive, so it is removed as soon as the swap has settled.
 */
const THEME_FADE_MS = 180;
const THEME_FADE_SLACK_MS = 40;
let themeFadeTimer: number | undefined;

function applyTheme(theme: Theme, animate = false) {
  const root = document.documentElement;

  if (animate) {
    root.classList.add("theme-switching");
    if (themeFadeTimer !== undefined) window.clearTimeout(themeFadeTimer);
    themeFadeTimer = window.setTimeout(() => {
      themeFadeTimer = undefined;
      root.classList.remove("theme-switching");
    }, THEME_FADE_MS + THEME_FADE_SLACK_MS);
  }

  root.classList.remove("dark", "soft", "light");
  root.classList.add(theme);
  // Keep the native surfaces (form controls, scrollbars) and the mobile browser
  // chrome in step with the app theme. index.html sets these pre-paint; without
  // this they would stay on the *initial* theme after a toggle.
  root.style.colorScheme = theme === "light" ? "light" : "dark";
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content =
      theme === "light" ? "#f9fafb" : theme === "soft" ? "#232426" : "#131415";
  }
  localStorage.setItem("scout-theme", theme);
}

// Make sure the DOM matches the stored value on first load. Never animated —
// there is no previous theme to fade from, and index.html has already painted
// the stored theme pre-hydration.
applyTheme(currentTheme);

function setThemeInternal(theme: Theme) {
  if (theme === currentTheme) return;
  if (theme !== "light") {
    preferredDarkTheme = theme;
    localStorage.setItem("scout-dark-theme", theme);
  }
  currentTheme = theme;
  applyTheme(theme, true);
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
