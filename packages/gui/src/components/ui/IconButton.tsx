import type { ButtonHTMLAttributes } from "react";
import { Tooltip } from "./Tooltip";

/**
 * Icon-only control with a guaranteed ≥32px hit box and a required accessible
 * name.
 *
 * ~12 sites hand-rolled `rounded-btn p-2 text-scout-muted hover:bg-scout-lift
 * hover:text-scout-text` — several character-identical, several at 16–24px,
 * and several with no `aria-label` at all (where `title` was the only name).
 * `aria-label` is required here rather than optional so that can't recur.
 *
 * The label is also shown as a `Tooltip` rather than a native `title`: native
 * tooltips are OS-styled, ~1s delayed, invisible on touch and unreachable by
 * keyboard. Routing it through this component is what adopts the tooltip
 * primitive across the app in one place.
 */
export function IconButton({
  label,
  size = "md",
  tone = "neutral",
  showTitle = true,
  className = "",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  /** Accessible name; also used as the tooltip unless `showTitle` is false. */
  label: string;
  size?: "md" | "lg";
  tone?: "neutral" | "danger";
  /** Set false for controls whose purpose is already obvious in context. */
  showTitle?: boolean;
}) {
  const box = size === "lg" ? "h-9 w-9" : "h-8 w-8";
  const toneClass =
    tone === "danger"
      ? "text-scout-muted hover:bg-scout-error-muted hover:text-scout-error"
      : "text-scout-muted hover:bg-scout-lift hover:text-scout-text";

  const button = (
    <button
      type="button"
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-btn transition-colors disabled:pointer-events-none disabled:opacity-50 ${box} ${toneClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );

  if (!showTitle) return button;
  return <Tooltip label={label}>{button}</Tooltip>;
}
