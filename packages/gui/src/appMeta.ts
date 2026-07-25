// Single source of truth for version + shortcuts, rendered by both
// HelpDialog and the settings shortcuts section so the two never drift apart.
export const APP_VERSION = "v0.1.0";

export const SHORTCUTS = [
  { keys: "Enter", desc: "Send message" },
  { keys: "Shift + Enter", desc: "New line in input" },
  { keys: "/", desc: "Open commands menu" },
  { keys: "@", desc: "Reference a file" },
  { keys: "Esc", desc: "Dismiss dropdowns" },
];
