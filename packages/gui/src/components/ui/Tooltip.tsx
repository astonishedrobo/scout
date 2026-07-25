import { cloneElement, useId, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useFloating, autoUpdate, offset, flip, shift, type Placement } from "@floating-ui/react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

/** Native tooltips wait about a second; this is the standard hover intent. */
const OPEN_DELAY_MS = 350;

/**
 * In-design tooltip.
 *
 * There were 32 native `title=` attributes and no primitive. Native tooltips
 * are OS-styled (so they break the design language), delayed by ~1s, invisible
 * on touch, and unreachable by keyboard.
 *
 * This is presentation only: it labels a control that already has its own
 * accessible name, and is `aria-hidden` so it never doubles the announcement.
 * If the trigger has no visible text, give it an `aria-label` — do NOT rely on
 * the tooltip for the name.
 */
export function Tooltip({
  label,
  // Below the control by default. Above is the usual tooltip convention, but
  // most of this app's icon buttons live in a 52px top bar, where a top-placed
  // tooltip has nowhere to go and ends up over the header.
  placement = "bottom",
  children,
}: {
  label: string;
  placement?: Placement;
  /** A single focusable element. */
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const reducedMotion = usePrefersReducedMotion();
  const id = useId();

  const { refs, floatingStyles, isPositioned } = useFloating({
    open,
    placement,
    // `fixed`, not the default `absolute`: the tooltip is portaled to <body>,
    // so absolute positioning resolves against the document and mispositions
    // near the viewport edges.
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  // Compose with whatever handlers the trigger already has rather than
  // replacing them — otherwise wrapping a control in a Tooltip would silently
  // drop its own hover/focus behaviour.
  const own = children.props as Record<string, ((e: unknown) => void) | undefined>;
  const chain = (mine: () => void, theirs?: (e: unknown) => void) => (e: unknown) => {
    theirs?.(e);
    mine();
  };

  const trigger = cloneElement(children, {
    ref: refs.setReference,
    onMouseEnter: chain(show, own.onMouseEnter),
    onMouseLeave: chain(hide, own.onMouseLeave),
    // Keyboard parity: a native title never appears on focus.
    onFocus: chain(() => setOpen(true), own.onFocus),
    onBlur: chain(hide, own.onBlur),
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {open
        && createPortal(
          <div
            id={id}
            ref={refs.setFloating}
            style={floatingStyles}
            role="presentation"
            aria-hidden="true"
            // Hidden until measured: the first frame is laid out at 0,0, which
            // showed the tooltip flashing in the top-left corner.
            className={`pointer-events-none z-[90] rounded-btn border border-scout-hairline bg-scout-panel px-2 py-1 text-micro font-medium text-scout-text shadow-pop ${
              isPositioned ? (reducedMotion ? "" : "animate-enter") : "invisible"
            }`}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
