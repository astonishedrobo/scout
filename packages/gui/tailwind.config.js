/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Channel-based tokens wrapped so Tailwind can inject alpha via /opacity.
        // Pre-blended rgba fills (*-muted, *-faint) are passed through plainly.
        scout: {
          canvas: "rgb(var(--scout-canvas) / <alpha-value>)",
          panel: "rgb(var(--scout-panel) / <alpha-value>)",
          void: "rgb(var(--scout-void) / <alpha-value>)",
          charcoal: "rgb(var(--scout-charcoal) / <alpha-value>)",
          text: "rgb(var(--scout-text) / <alpha-value>)",
          "text-inverse": "rgb(var(--scout-text-inverse) / <alpha-value>)",
          muted: "rgb(var(--scout-muted) / <alpha-value>)",
          hairline: "rgb(var(--scout-hairline) / <alpha-value>)",
          "hairline-faint": "var(--scout-hairline-faint)",
          lift: "rgb(var(--scout-lift) / <alpha-value>)",
          bg: "rgb(var(--scout-bg) / <alpha-value>)",
          surface: "rgb(var(--scout-surface) / <alpha-value>)",
          "surface-hover": "rgb(var(--scout-surface-hover) / <alpha-value>)",
          "sidebar-bg": "rgb(var(--scout-sidebar-bg) / <alpha-value>)",
          "sidebar-hover": "rgb(var(--scout-sidebar-hover) / <alpha-value>)",
          border: "rgb(var(--scout-border) / <alpha-value>)",
          "text-primary": "rgb(var(--scout-text-primary) / <alpha-value>)",
          "text-secondary": "rgb(var(--scout-text-secondary) / <alpha-value>)",
          peach: "rgb(var(--scout-peach) / <alpha-value>)",
          "peach-muted": "var(--scout-peach-muted)",
          lavender: "rgb(var(--scout-lavender) / <alpha-value>)",
          "lavender-muted": "var(--scout-lavender-muted)",
          amber: "rgb(var(--scout-amber) / <alpha-value>)",
          "amber-muted": "var(--scout-amber-muted)",
          "card-lavender": "rgb(var(--scout-card-lavender) / <alpha-value>)",
          "card-peach": "rgb(var(--scout-card-peach) / <alpha-value>)",
          "card-amber": "rgb(var(--scout-card-amber) / <alpha-value>)",
          "card-lavender-hover": "rgb(var(--scout-card-lavender-hover) / <alpha-value>)",
          "card-peach-hover": "rgb(var(--scout-card-peach-hover) / <alpha-value>)",
          "card-amber-hover": "rgb(var(--scout-card-amber-hover) / <alpha-value>)",
          "accent-cta": "rgb(var(--scout-accent-cta) / <alpha-value>)",
          action: "rgb(var(--scout-action) / <alpha-value>)",
          "action-muted": "var(--scout-action-muted)",
          success: "rgb(var(--scout-success) / <alpha-value>)",
          "success-muted": "var(--scout-success-muted)",
          error: "rgb(var(--scout-error) / <alpha-value>)",
          "error-muted": "var(--scout-error-muted)",
          warning: "rgb(var(--scout-warning) / <alpha-value>)",
          "warning-muted": "var(--scout-warning-muted)",
          cyan: "rgb(var(--scout-cyan) / <alpha-value>)",
          "code-bg": "rgb(var(--scout-code-bg) / <alpha-value>)",
          "input-bg": "rgb(var(--scout-input-bg) / <alpha-value>)",
        },
      },
      fontFamily: {
        // "Inter Variable" is the family name the self-hosted variable build
        // registers (see the @fontsource import in main.tsx) — it must come
        // FIRST. Plain "Inter" stays next as a fallback for machines with a
        // static Inter installed locally.
        sans: [
          "Inter Variable",
          "Inter",
          "SF Pro Text",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "Inter Variable",
          "Inter",
          "SF Pro Display",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "Cascadia Code",
          "monospace",
        ],
      },
      borderRadius: {
        pill: "var(--radius-pill)",
        hero: "var(--radius-hero)",
        card: "var(--radius-card)",
        btn: "var(--radius-btn)",
      },
      boxShadow: {
        pop: "var(--shadow-pop)",
        "card-hover": "var(--shadow-card-hover)",
        composer: "var(--shadow-composer)",
      },
      // Motion tokens. The easing was previously repeated as a literal
      // cubic-bezier in three places; `ease-swift` is now the single name for it.
      transitionTimingFunction: {
        swift: "var(--ease-swift)",
      },
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        panel: "var(--dur-panel)",
        drawer: "var(--dur-drawer)",
        glide: "var(--dur-glide)",
      },
    },
  },
  plugins: [],
};
