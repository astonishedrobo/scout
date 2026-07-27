import type { ReactNode } from "react";

/**
 * One settings row: label (+ description) on the left, exactly one control on
 * the right.
 *
 * The old panels had no row primitive at all — content was a stack of
 * full-width `<section>`s with the heading above and the control below, so peer
 * settings never lined up and each one invented its own label typography
 * (eleven different label class strings in SettingsPanel alone).
 *
 * Below `sm` the control drops under the text rather than squeezing beside it.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  control,
  danger,
  children,
  className = "",
}: {
  label: ReactNode;
  description?: ReactNode;
  /** Set when `control` is a labellable form element with this id. */
  htmlFor?: string;
  /** The single right-aligned control. */
  control?: ReactNode;
  /** Tints the label — for rows whose action destroys something. */
  danger?: boolean;
  /**
   * Extra content belonging to this row, rendered inside the same row band.
   * Deliberately unstyled and unboxed so a nested list (MCP tools) does not
   * reintroduce a box inside the group's box.
   */
  children?: ReactNode;
  className?: string;
}) {
  const Text = htmlFor ? "label" : "div";

  return (
    <div className={`px-4 py-2.5 sm:px-4 ${className}`}>
      <div className="flex min-h-[28px] flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Text
          {...(htmlFor ? { htmlFor } : {})}
          className={`min-w-0 flex-1 ${htmlFor ? "cursor-pointer" : ""}`}
        >
          <span
            className={`block text-label font-medium ${danger ? "text-scout-error" : "text-scout-text"}`}
          >
            {label}
          </span>
          {description && (
            <span className="mt-0.5 block text-caption leading-relaxed text-scout-muted">
              {description}
            </span>
          )}
        </Text>
        {control && <div className="flex shrink-0 items-center gap-2 sm:justify-end">{control}</div>}
      </div>
      {children}
    </div>
  );
}
