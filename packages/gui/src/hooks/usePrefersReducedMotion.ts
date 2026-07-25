import { useSyncExternalStore } from "react";
import { readLocalSetting, subscribeLocalSettings } from "./useLocalSetting";

const QUERY = "(prefers-reduced-motion: reduce)";
const SETTING_KEY = "appearance.reduceMotion";

/*
 * Shared via a single module-level media-query listener rather than one per
 * hook instance — `usePresence` is used per tool step and per list row, so a
 * long session would otherwise accumulate hundreds of identical listeners.
 * Same pattern as useTheme's external store.
 */
const mql =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(QUERY)
    : null;

const listeners = new Set<() => void>();

function systemPrefers(): boolean {
  return mql ? mql.matches : false;
}

/**
 * The effective answer: the OS asking for reduced motion, or the user asking for
 * it in Appearance. Either one wins — a setting that the OS could veto would be
 * a setting that does nothing for most people.
 */
function effective(): boolean {
  return systemPrefers() || readLocalSetting(SETTING_KEY, false);
}

/**
 * The CSS half of the motion system reads `:root[data-motion="reduce"]` rather
 * than the media query directly, so one attribute covers both sources.
 *
 * Stamped at module load — before React renders anything — so the elements that
 * carry entrance animations never paint an animation we are about to suppress.
 * Same approach as `applyTheme` in useTheme.
 */
function applyMotion() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (effective()) root.setAttribute("data-motion", "reduce");
  else root.removeAttribute("data-motion");
}

applyMotion();

function publish() {
  applyMotion();
  for (const listener of listeners) listener();
}

mql?.addEventListener("change", publish);
// The Appearance switch writes through `useLocalSetting`, which publishes here.
subscribeLocalSettings(publish);

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Whether motion should be reduced, from either source.
 *
 * Most of the motion system handles this in CSS, which is the right place for
 * it. This hook exists for the cases CSS cannot reach: deciding whether to
 * *hold an element mounted* for an exit animation (see `usePresence` — under
 * reduced motion it must unmount immediately, since a delay with no animation
 * is worse than a hard cut), and gating Tailwind classes that have no
 * `motion-reduce:` equivalent.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, effective, () => false);
}

/**
 * The OS preference alone.
 *
 * Only the Appearance section needs this, to explain that the system already
 * asks for reduced motion. Everything else wants `usePrefersReducedMotion`.
 */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, systemPrefers, () => false);
}

/** The stored preference alone — what the Appearance switch renders. */
export function useReduceMotionSetting(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readLocalSetting(SETTING_KEY, false),
    () => false,
  );
}
