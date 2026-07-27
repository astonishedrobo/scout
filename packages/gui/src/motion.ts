/**
 * Motion durations that JS needs to know about.
 *
 * These MUST stay in sync with the `--dur-*` custom properties in
 * styles/globals.css. Anywhere a timer has to outlive a CSS animation (a
 * `setTimeout` that unmounts an exiting element, or that removes a transition
 * class once it has settled), import from here rather than writing a literal —
 * `WorkspaceShell` previously hard-coded `340` as an unlinked duplicate of the
 * stylesheet's `300ms` glide, which is exactly the drift this prevents.
 */

/** Panel open/close width glide — `.panels-gliding > [data-panel]`. */
export const PANEL_GLIDE_MS = 300;

/**
 * Slack added to a CSS duration before tearing down the thing that drives it.
 * Covers the frame the animation starts on plus scheduling jitter.
 */
export const SETTLE_SLACK_MS = 40;

/** Exit durations, mirroring the `--dur-*-out` tokens. */
export const EXIT_MS = {
  /** `.animate-panel-out` and `.animate-modal-out`. */
  panel: 180,
  /** `.animate-drawer-out`. */
  drawer: 220,
  /** `.animate-backdrop-out`. */
  backdrop: 160,
  /** `.animate-collapse-out` — list-row removal. */
  collapse: 150,
} as const;
