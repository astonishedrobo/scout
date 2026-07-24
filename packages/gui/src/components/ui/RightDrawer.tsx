import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { usePresence } from "../../hooks/usePresence";
import { EXIT_MS } from "../../motion";

interface RightDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: number;
}

export function RightDrawer({
  open,
  onClose,
  title,
  children,
  width = 440,
}: RightDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { mounted, state } = usePresence(open, EXIT_MS.drawer);

  // Keyed on `open`, not `mounted` — see the note in CenterModal: the scroll
  // lock and focus restore must unwind when the exit starts, not when it ends.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  const exiting = state === "exiting";
  // A closing drawer stays on screen for the animation; don't let it be clicked.
  const backdropMotion = exiting
    ? "animate-backdrop-out pointer-events-none"
    : "animate-backdrop-in";

  return createPortal(
    <div
      className={`fixed inset-0 z-[50] flex justify-end bg-black/50 ${backdropMotion}`}
      role="presentation"
    >
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: Math.min(width, window.innerWidth) }}
        className={`relative h-full bg-scout-panel border-l border-scout-hairline shadow-pop flex flex-col outline-none ${
          exiting ? "animate-drawer-out" : "animate-drawer-in"
        }`}
      >
        <div className="flex items-center justify-between h-11 px-4 border-b border-scout-hairline shrink-0">
          {title ? (
            <h2 className="text-sm font-medium text-scout-text">{title}</h2>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-btn text-scout-muted hover:text-scout-text hover:bg-scout-lift transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
