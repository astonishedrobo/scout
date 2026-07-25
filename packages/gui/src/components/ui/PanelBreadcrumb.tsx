import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export interface Crumb {
  label: string;
  /** Makes the segment a button — used for the agents panel's back step. */
  onClick?: () => void;
}

/** Path segments for a workspace path, deepest last. */
export function pathCrumbs(path: string): Crumb[] {
  return path.split("/").filter(Boolean).map((label) => ({ label }));
}

/**
 * The row under the tab strip: where you are, plus this surface's own actions.
 *
 * Replaces the icon + title + subtitle band each panel used to render through
 * the old `PanelHeader` (now gone — these four surfaces were its only callers).
 * Two stacked header bars is the doubled-chrome look we removed from Settings, so
 * a surface inside the right panel gets this row and nothing else.
 */
export function PanelBreadcrumb({
  crumbs,
  meta,
  actions,
}: {
  crumbs: Crumb[];
  /** Quiet trailing detail — diff stats, a file count. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  if (crumbs.length === 0 && !meta && !actions) return null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-scout-hairline-faint bg-scout-canvas px-3">
      {/* The path owns only the space left over after metadata and actions.
          It stays anchored at the logical root and scrolls independently when
          it grows, while the controls remain pinned to the right. */}
      <nav
        aria-label="Location"
        className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto"
      >
        <ol className="flex shrink-0 items-center gap-1">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <li key={`${crumb.label}-${index}`} className="flex shrink-0 items-center gap-1">
                {index > 0 && (
                  <ChevronRight size={12} className="shrink-0 text-scout-muted/60" aria-hidden="true" />
                )}
                {crumb.onClick ? (
                  <button
                    type="button"
                    onClick={crumb.onClick}
                    className="rounded-btn px-1 text-caption text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span
                    className={`px-1 text-caption ${
                      last ? "font-medium text-scout-text" : "text-scout-muted"
                    }`}
                    aria-current={last ? "page" : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {meta && <span className="shrink-0 text-micro text-scout-muted">{meta}</span>}
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
