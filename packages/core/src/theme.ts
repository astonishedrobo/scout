/**
 * Semantic color theme for the Scout CLI.
 *
 * Modelled after Gemini CLI's dark theme palette, using their exact
 * hex values so the visual output matches.  We keep a flat, simple
 * object — no class hierarchy, no tinycolor dependency.
 */

export const theme = {
  /* ── Text ──────────────────────────────────────────────── */
  text: {
    /** Primary text — assistant responses, body copy. */
    primary: "#FFFFFF",
    /** Secondary text — metadata, timestamps, dim labels. */
    secondary: "#878787",
    /** Accent — branding, active prompt caret, highlights. */
    accent: "#D7AFFF",        // Gemini dark AccentPurple
    /** User input echo. */
    user: "#FFFFFF",
    /** Links / references. */
    link: "#87AFFF",          // Gemini dark AccentBlue
  },

  /* ── Backgrounds ───────────────────────────────────────── */
  background: {
    primary: "",              // terminal default
  },

  /* ── Borders ───────────────────────────────────────────── */
  border: {
    /** Default border for tool groups, separators. */
    default: "#878787",       // Gemini dark DarkGray
  },

  /* ── UI chrome ─────────────────────────────────────────── */
  ui: {
    /** Active/focused elements. */
    active: "#87AFFF",        // Gemini dark AccentBlue
    /** Dark chrome, e.g. subtle borders. */
    dark: "#878787",
    /** Spinner frames. */
    spinner: "#87AFFF",
  },

  /* ── Status ────────────────────────────────────────────── */
  status: {
    success: "#D7FFD7",       // Gemini dark AccentGreen
    error: "#FF87AF",         // Gemini dark AccentRed
    warning: "#FFFFAF",       // Gemini dark AccentYellow
    /** Spinner / in-progress — same as ui.active. */
    active: "#87AFFF",
  },

  /* ── Brand accents ─────────────────────────────────────── */
  brand: {
    /** Vivid per-provider accents for pickers and the deploy wizard. */
    openai: "#5FD7A7",
    groq: "#FFAF5F",
    anthropic: "#FF875F",
    vllm: "#87AFFF",
    /** Muted chrome for frames and inactive borders. */
    frame: "#4E4E4E",
  },

  /* ── Tool steps ────────────────────────────────────────── */
  tool: {
    /** Tool name in activity log. */
    name: "#87D7D7",          // Gemini dark AccentCyan
    /** Tool arguments summary. */
    args: "#878787",
    /** Tool output preview. */
    output: "#AFAFAF",        // Gemini dark Comment/Gray
  },
} as const;

/** Status icons for tool step indicators. */
export const STATUS_ICONS = {
  executing: "⠋",            // replaced by <Spinner> at render time
  complete: "✓",
  error: "✗",
} as const;

/** Horizontal separator line for a given width. */
export function separator(width: number): string {
  return "─".repeat(Math.max(0, width));
}
