import { ThinkingOrb, type OrbState } from "thinking-orbs";

/**
 * Decorative activity indicator. Deliberately state-free: a single calm visual
 * language reads faster than a different animated orb per tool, and adjacent
 * text always says what Scout is doing. It is `aria-hidden` for the same
 * reason — every call site renders that text visibly, so labelling the orb too
 * announced it twice.
 */
export function ActivityOrb({ className = "" }: { className?: string }) {
  return (
    <ThinkingOrb
      state={"listening" as OrbState}
      size={20}
      theme="auto"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    />
  );
}
