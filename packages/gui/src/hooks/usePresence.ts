import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type PresenceState = "entering" | "exiting";

export interface Presence {
  /** Whether the caller should render at all. Stays true during the exit. */
  mounted: boolean;
  /** Which animation class the caller should apply. */
  state: PresenceState;
}

/**
 * Keeps an element mounted long enough to animate out.
 *
 * Overlays in this app used to unmount on the same commit that closed them
 * (`if (!open) return null`), so there was nothing left for CSS to animate —
 * every modal, drawer and list row popped out of existence. This holds the
 * element for `exitMs` after `open` goes false, during which the caller
 * applies an `.animate-*-out` class.
 *
 * Chosen over `framer-motion`'s AnimatePresence deliberately: FM leaves an
 * inline `transform` on the element after animating, which is exactly the
 * persistent-transform containing-block hazard documented in globals.css
 * (it breaks `position: fixed` overlays rendered inside messages).
 *
 * Under reduced motion the element unmounts immediately — holding it for a
 * delay it will not animate through is strictly worse than a hard cut.
 *
 * Callers must keep any side-effecting logic (scroll locks, focus restore,
 * key listeners) keyed on `open`, NOT on `mounted`, so it unwinds when the
 * exit *starts* rather than when it finishes.
 */
export function usePresence(open: boolean, exitMs: number): Presence {
  const reducedMotion = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (open) {
      // Re-opening mid-exit must cancel the pending unmount, or the element
      // disappears a moment after the user reopens it.
      clearTimer();
      setMounted(true);
      return;
    }

    if (!mounted) return;

    if (reducedMotion || exitMs <= 0) {
      clearTimer();
      setMounted(false);
      return;
    }

    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setMounted(false);
    }, exitMs);

    return clearTimer;
  }, [open, mounted, exitMs, reducedMotion]);

  // Guard against a pending timer firing after the owner itself unmounts.
  useEffect(() => clearTimer, []);

  return { mounted, state: open ? "entering" : "exiting" };
}
