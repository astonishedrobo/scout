/**
 * Shared top-bar control classes so the sidebar toggle and right-hand actions
 * share the same height, radius, and weight.
 */

/** Icon-only control (sidebar collapse). */
export const headerIconButtonClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-btn text-scout-muted hover:text-scout-text hover:bg-scout-lift/80 transition-colors";

/**
 * Labeled action button base (Files, Upload). Pair with idle/active/status —
 * those variants carry the hover styles, and the transition lives here.
 * Scoped to colors deliberately: `transition-all` also animates width/padding,
 * which wobbles when a label changes.
 */
export const headerActionButtonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-btn border px-2.5 text-xs font-medium transition-colors";

export const headerActionIdleClass =
  "border-scout-hairline-faint bg-scout-panel/40 text-scout-muted hover:bg-scout-lift/80 hover:text-scout-text";

export const headerActionActiveClass =
  "border-scout-hairline bg-scout-lift text-scout-text";
