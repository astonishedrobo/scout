import type { ReactNode } from "react";

/**
 * Small status label. Replaces seven hand-rolled variants of "small uppercase
 * text" that used four different letter-spacings.
 */
export type BadgeTone = "neutral" | "success" | "error" | "warning" | "info";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-scout-lift text-scout-muted",
  success: "bg-scout-success-muted text-scout-success",
  error: "bg-scout-error-muted text-scout-error",
  warning: "bg-scout-warning-muted text-scout-warning",
  info: "bg-scout-lavender-muted text-scout-lavender",
};

export function Badge({
  tone = "neutral",
  uppercase = false,
  title,
  className = "",
  children,
}: {
  tone?: BadgeTone;
  /** Uppercase variant for status/kind labels; sentence case for counts. */
  uppercase?: boolean;
  /** Hover explanation. The badge text must still stand alone without it. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-micro font-semibold ${
        uppercase ? "uppercase tracking-[0.08em]" : ""
      } ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
