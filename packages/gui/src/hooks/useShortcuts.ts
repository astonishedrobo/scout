import { useEffect, useRef } from "react";
import { SHORTCUTS, matchesBinding, type ShortcutId } from "../shortcuts";
import { hasOpenDialog } from "./useDialogShell";

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>;

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The app's only global accelerator listener.
 *
 * Before this, every `document` keydown listener in the codebase was a focus
 * trap or a popover dismiss; there were no application shortcuts at all.
 *
 * Handlers are held in a ref so a caller passing a fresh object literal every
 * render does not re-register the listener on every render.
 */
export function useShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      // A dialog owns the screen and its own keys while it is open.
      if (hasOpenDialog()) return;
      // Autorepeat would fire the action once per frame while a key is held.
      if (event.repeat) return;

      for (const shortcut of SHORTCUTS) {
        if (!shortcut.binding) continue;
        if (!matchesBinding(event, shortcut.binding)) continue;
        // A shortcut with no modifier must never steal a keystroke from a text
        // field. Ours all carry one, but the guard belongs with the rule.
        const bare = !shortcut.binding.mod && !shortcut.binding.alt;
        if (bare && isTextEntry(event.target)) return;

        const handler = handlersRef.current[shortcut.id as ShortcutId];
        if (!handler) return;
        // Only claim the event once we know we are acting on it, so an
        // unhandled id still falls through to the browser.
        event.preventDefault();
        handler();
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
