import type { ReactNode } from "react";

/**
 * A labelled group of settings rows.
 *
 * The label sits *outside* and above a single flat container, and the container
 * is the only bordered box in the group. This is the fix for the old panels,
 * where the whole tab body was wrapped in `rounded-hero border bg-scout-panel/80`
 * and every item inside then drew its own border and fill — boxes inside a box,
 * three borders deep at the provider cards.
 *
 * Rule for anything rendered as a child: no borders, no fills. The group owns
 * both.
 */
export function SettingsGroup({
  label,
  description,
  action,
  footnote,
  className = "",
  children,
}: {
  label?: ReactNode;
  description?: ReactNode;
  /** Right-aligned control on the label line — e.g. a quiet Save. */
  action?: ReactNode;
  /** Small print under the container, e.g. "Saved on this device". */
  footnote?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`space-y-2 ${className}`}>
      {(label || action) && (
        <div className="flex min-h-[24px] items-center justify-between gap-3 px-0.5">
          <div className="min-w-0">
            {label && <h2 className="text-label font-semibold text-scout-text">{label}</h2>}
            {description && (
              <p className="mt-0.5 text-caption leading-relaxed text-scout-muted">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="divide-y divide-scout-hairline-faint overflow-hidden rounded-control border border-scout-hairline-faint bg-scout-panel/30">
        {children}
      </div>
      {footnote && <p className="px-0.5 text-micro text-scout-muted/80">{footnote}</p>}
    </section>
  );
}
