import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // offsetParent is null for display:none subtrees; a hidden control must not
    // become the Tab boundary.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Open dialogs, outermost first.
 *
 * Escape and Tab must only be handled by the topmost dialog. Every shell listens
 * on `document`, and listeners fire in registration order, so without this the
 * *outer* dialog wins: pressing Escape on a confirm dialog inside the settings
 * surface closed the whole surface underneath it.
 */
const stack: RefObject<HTMLElement>[] = [];

/**
 * True while any modal shell is open.
 *
 * Global accelerators must stand down when a dialog owns the screen — opening a
 * panel tab from behind the settings surface would leave you looking at the
 * dialog while the app changed underneath it. Exported from here so there is one
 * notion of "a dialog is open", not two that can disagree.
 */
export function hasOpenDialog(): boolean {
  return stack.length > 0;
}

/**
 * Shared modal-shell behaviour: initial focus, body scroll lock, focus restore,
 * optional Escape, and — the part that was missing — Tab containment.
 *
 * `aria-modal="true"` promises the rest of the page is inert. Without a trap
 * that promise is false: Tab walks straight out into the scroll-locked page
 * behind the dialog, which is unusable for a dialog that also declines to close
 * on Escape (see ApprovalModal).
 *
 * Deliberately keyed on `open`, NOT on a presence/`mounted` flag: the cleanup
 * releases the scroll lock and restores focus, and both must happen when the
 * exit STARTS, not ~180ms later when the animation ends.
 */
export function useDialogShell(
  open: boolean,
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
  closeOnEscape = true,
) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    // Prefer the first real control so keyboard users start inside the content
    // rather than on the container; fall back to the panel itself.
    const initial = panel ? focusableWithin(panel)[0] : null;
    (initial ?? panel)?.focus();

    stack.push(panelRef);

    const onKey = (e: KeyboardEvent) => {
      // Only the innermost open dialog reacts.
      if (stack[stack.length - 1] !== panelRef) return;
      if (e.key === "Escape" && closeOnEscape) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;

      const items = focusableWithin(panel);
      if (items.length === 0) {
        // Nothing to land on: keep focus on the panel rather than leaking out.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      // Wrap at both ends, and pull focus back in if it has already escaped
      // (e.g. focus was on the backdrop or restored asynchronously).
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.lastIndexOf(panelRef);
      if (at >= 0) stack.splice(at, 1);
      // Only the last dialog to close releases the scroll lock; an inner dialog
      // closing must not let the page behind the outer one start scrolling.
      if (stack.length === 0) document.body.style.overflow = "";
      prev?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, closeOnEscape]);
}
