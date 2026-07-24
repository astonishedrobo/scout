import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

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

function subscribe(onChange: () => void) {
  if (!mql) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return mql ? mql.matches : false;
}

/**
 * Whether the user has asked for reduced motion.
 *
 * Most of the motion system handles this in CSS, which is the right place for
 * it. This hook exists for the cases CSS cannot reach: deciding whether to
 * *hold an element mounted* for an exit animation (see `usePresence` — under
 * reduced motion it must unmount immediately, since a delay with no animation
 * is worse than a hard cut), and gating Tailwind classes that have no
 * `motion-reduce:` equivalent.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
