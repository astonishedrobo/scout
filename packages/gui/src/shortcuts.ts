/**
 * Every keyboard shortcut in the app, once.
 *
 * Both the documentation surfaces (HelpDialog, the settings shortcuts section)
 * and the actual key handling read this list, plus the chips in the right-panel
 * launcher — so a binding cannot be shown one way and behave another.
 *
 * Entries with a `binding` are live accelerators. Entries with a `literal` are
 * documentation for keys handled locally by the control that owns them (the
 * composer's Enter, `/`, `@`), which have no place in a global listener.
 */

export type ShortcutId =
  | "panel.files"
  | "panel.review"
  | "panel.agents"
  | "panel.toggle"
  | "panel.closeTab";

export interface Binding {
  /** Cmd on Apple platforms, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * A `KeyboardEvent.code`, not a `key`. `key` changes with the layout and with
   * Alt held (Alt+W reports "∑" on macOS), so a code is the only stable match.
   */
  code: string;
}

export interface ShortcutDef {
  id: string;
  desc: string;
  binding?: Binding;
  /** Pre-formatted keys for documentation-only entries. */
  literal?: string;
  group: "Right panel" | "Composer";
}

/**
 * Every panel binding uses Alt (⌥) and nothing else.
 *
 * Scout runs in a browser, not only in a desktop shell, so the tab-strip
 * shortcuts a native app can take are not ours to take. Cmd/Ctrl+P is print,
 * Cmd/Ctrl+Shift+R is hard reload, Cmd+Shift+A is Chrome's tab search, and
 * Cmd/Ctrl+W closes the window without letting us cancel it — that last one
 * would silently end the session. Alt+letter is unclaimed across Chrome,
 * Firefox and Safari on every platform, so one set works everywhere.
 */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: "panel.files",
    desc: "Open workspace files",
    binding: { alt: true, code: "KeyF" },
    group: "Right panel",
  },
  {
    id: "panel.review",
    desc: "Review this turn's file changes",
    binding: { alt: true, code: "KeyR" },
    group: "Right panel",
  },
  {
    id: "panel.agents",
    desc: "Open agents and tasks",
    binding: { alt: true, code: "KeyA" },
    group: "Right panel",
  },
  {
    id: "panel.toggle",
    desc: "Show or hide the side panel",
    binding: { alt: true, code: "KeyP" },
    group: "Right panel",
  },
  {
    id: "panel.closeTab",
    desc: "Close the active panel tab",
    binding: { alt: true, code: "KeyW" },
    group: "Right panel",
  },
  { id: "composer.send", desc: "Send message", literal: "Enter", group: "Composer" },
  { id: "composer.newline", desc: "New line in input", literal: "Shift + Enter", group: "Composer" },
  { id: "composer.commands", desc: "Open commands menu", literal: "/", group: "Composer" },
  { id: "composer.mention", desc: "Reference a file", literal: "@", group: "Composer" },
  { id: "composer.dismiss", desc: "Dismiss dropdowns", literal: "Esc", group: "Composer" },
];

let applePlatform: boolean | null = null;

export function isApplePlatform(): boolean {
  // Resolved once, but lazily — `navigator` is read at first use, not at import.
  if (applePlatform === null) {
    applePlatform =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  }
  return applePlatform;
}

/** Human label for a code: "KeyP" → "P", "Backslash" → "\". */
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Backslash") return "\\";
  return code;
}

/** "⌘⇧R" on Apple platforms, "Ctrl+Shift+R" elsewhere. */
export function formatBinding(binding: Binding): string {
  const apple = isApplePlatform();
  const parts: string[] = [];
  if (binding.mod) parts.push(apple ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(apple ? "⇧" : "Shift");
  if (binding.alt) parts.push(apple ? "⌥" : "Alt");
  parts.push(codeLabel(binding.code));
  return apple ? parts.join("") : parts.join("+");
}

/** The keys to display for a shortcut, whichever kind it is. */
export function shortcutKeys(shortcut: ShortcutDef): string {
  return shortcut.binding ? formatBinding(shortcut.binding) : (shortcut.literal ?? "");
}

export function shortcutById(id: ShortcutId): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Formatted keys for one id — what the launcher rows show. */
export function keysFor(id: ShortcutId): string | undefined {
  const shortcut = shortcutById(id);
  return shortcut?.binding ? formatBinding(shortcut.binding) : undefined;
}

export function matchesBinding(event: KeyboardEvent, binding: Binding): boolean {
  if (event.code !== binding.code) return false;
  const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
  // Every modifier is checked, including the ones the binding does not want —
  // otherwise Cmd+Shift+P would also fire the plain Cmd+P shortcut.
  if (mod !== !!binding.mod) return false;
  if (event.shiftKey !== !!binding.shift) return false;
  if (event.altKey !== !!binding.alt) return false;
  // The other platform's modifier must not be held.
  if (isApplePlatform() ? event.ctrlKey : event.metaKey) return false;
  return true;
}
