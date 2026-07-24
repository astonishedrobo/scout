import type { ReactNode } from "react";
import { usePresence } from "../../hooks/usePresence";
import { EXIT_MS } from "../../motion";

interface PresenceProps {
  /** Whether the content should be shown. Flipping to false animates out. */
  show: boolean;
  /** Class applied while exiting. Defaults to the list-row collapse. */
  exitClass?: string;
  /** Class applied while entering. */
  enterClass?: string;
  /** Must match the duration of `exitClass`. */
  exitMs?: number;
  /**
   * Element to render. A plain wrapper `div` by default; pass `"li"`/`"tr"`
   * where the parent constrains what children are legal.
   */
  as?: "div" | "li" | "tr" | "span";
  className?: string;
  children: ReactNode;
}

/**
 * Declarative wrapper around `usePresence`, so list call sites stay readable:
 *
 *   <Presence key={row.id} show={!row.dismissed}>{…}</Presence>
 *
 * Renders nothing once the exit has finished. Reduced motion is handled inside
 * `usePresence` — it unmounts immediately rather than pausing on a class that
 * has no animation attached.
 */
export function Presence({
  show,
  exitClass = "animate-collapse-out",
  enterClass,
  exitMs = EXIT_MS.collapse,
  as: Tag = "div",
  className = "",
  children,
}: PresenceProps) {
  const { mounted, state } = usePresence(show, exitMs);

  if (!mounted) return null;

  const motionClass = state === "exiting" ? exitClass : (enterClass ?? "");

  return <Tag className={`${className} ${motionClass}`.trim()}>{children}</Tag>;
}
