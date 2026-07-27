import {
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  size,
  type Placement,
} from "@floating-ui/react";

interface AnchoredPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement?: Placement;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  className?: string;
}

export function AnchoredPopover({
  open,
  onClose,
  anchorRef,
  children,
  placement = "top-start",
  matchAnchorWidth = false,
  maxHeight = 280,
  className = "",
}: AnchoredPopoverProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open,
    onOpenChange: (v) => {
      if (!v) onClose();
    },
    placement,
    // `fixed`, not the default `absolute`: this is portaled to <body>, so
    // absolute coordinates resolve against the document and drift once the page
    // behind it is scrolled. (Same bug the tooltip had.)
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        apply({ rects, elements, availableHeight }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.min(maxHeight, availableHeight - 8)}px`,
            ...(matchAnchorWidth ? { width: `${rects.reference.width}px` } : {}),
          });
        },
      }),
    ],
  });

  useEffect(() => {
    if (open && anchorRef.current) {
      refs.setReference(anchorRef.current);
    }
  }, [open, anchorRef, refs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        refs.floating.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorRef, refs.floating]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className={`z-[70] ${isPositioned ? "" : "invisible"}`}
      data-floating={context.open}
    >
      {/*
        Floating UI positions its reference with `transform: translate(...)`.
        Motion must live on a child: animating this wrapper would overwrite that
        transform and pin the popover to 0,0.
      */}
      <div
        className={`origin-top overflow-hidden overflow-y-auto rounded-surface border border-scout-hairline-faint bg-scout-panel/95 shadow-pop backdrop-blur-xl animate-enter ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
