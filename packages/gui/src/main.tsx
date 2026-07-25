import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

/*
 * Inter and JetBrains Mono head the font stacks in tailwind.config.js, but
 * nothing ever loaded them — so on any machine without them installed locally
 * the whole UI silently fell back to system-ui, while the tuned letter-spacing
 * (body -0.011em, .font-display -0.04em) stayed calibrated for Inter.
 * Self-hosted rather than a CDN link: works offline, inside the Electron
 * shell, and under a strict CSP.
 *
 * Inter is the variable (wght-axis) build, so the whole 400-620 range the UI
 * uses costs one file instead of four static weights. Each @font-face carries
 * a unicode-range, so only the ~48K latin subset actually transfers while
 * other scripts stay covered if a session needs them.
 */
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";

import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
