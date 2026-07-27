import type { ReactNode } from "react";

/**
 * A pressable pill — a toggle that reads as a toggle.
 *
 * This replaces two hand-rolled controls in the MCP panel where a click mutated
 * security posture (read → write access) while the control looked like a static
 * label, and where the safe and dangerous states shared one tone. If pressing it
 * changes what the system may do, that has to be visible before the click, not
 * after.
 *
 * `Badge` remains the right choice for something you cannot press.
 */
export type ChipTone = "neutral" | "success" | "warning" | "danger" | "info";

/** Unpressed: quiet, uniform. The chip's job here is to look available. */
const idle =
  "border-scout-hairline-faint text-scout-muted hover:border-scout-hairline hover:text-scout-text";

/** Pressed: tone-carrying, so a dangerous selection is distinct from a safe one. */
const pressedTones: Record<ChipTone, string> = {
  neutral: "border-scout-text/30 bg-scout-lift text-scout-text",
  success: "border-scout-success/40 bg-scout-success-muted text-scout-success",
  warning: "border-scout-warning/40 bg-scout-warning-muted text-scout-warning",
  danger: "border-scout-error/40 bg-scout-error-muted text-scout-error",
  info: "border-scout-lavender/40 bg-scout-lavender-muted text-scout-lavender",
};

export function Chip({
  children,
  pressed = false,
  tone = "neutral",
  onClick,
  disabled,
  title,
  label,
  className = "",
}: {
  children: ReactNode;
  pressed?: boolean;
  /** Applied when pressed. Use `danger` for a state that widens capability. */
  tone?: ChipTone;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** Accessible name, when the visible text alone is not self-describing. */
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1 text-micro font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 disabled:cursor-not-allowed disabled:opacity-50 ${
        pressed ? pressedTones[tone] : idle
      } ${className}`}
    >
      {children}
    </button>
  );
}
