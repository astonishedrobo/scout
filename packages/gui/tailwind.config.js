/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        scout: {
          bg: "var(--scout-bg)",
          surface: "var(--scout-surface)",
          "surface-hover": "var(--scout-surface-hover)",
          "sidebar-bg": "var(--scout-sidebar-bg)",
          "sidebar-hover": "var(--scout-sidebar-hover)",
          border: "var(--scout-border)",
          "text-primary": "var(--scout-text-primary)",
          "text-secondary": "var(--scout-text-secondary)",
          accent: "var(--scout-accent)",
          "accent-hover": "var(--scout-accent-hover)",
          "accent-muted": "var(--scout-accent-muted)",
          success: "#4ade80",
          "success-muted": "rgba(74,222,128,0.15)",
          error: "#f87171",
          "error-muted": "rgba(248,113,113,0.15)",
          warning: "#fbbf24",
          "warning-muted": "rgba(251,191,36,0.15)",
          cyan: "#22d3ee",
          "code-bg": "var(--scout-code-bg)",
          "input-bg": "var(--scout-input-bg)",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "Cascadia Code",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
