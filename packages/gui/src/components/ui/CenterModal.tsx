import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { usePresence } from "../../hooks/usePresence";
import { EXIT_MS } from "../../motion";

interface CenterModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxWidth?: "sm" | "md" | "lg";
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  showClose?: boolean;
}

const maxWidths = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function CenterModal({
  open,
  onClose,
  title,
  children,
  maxWidth = "md",
  closeOnEscape = true,
  closeOnBackdrop = true,
  showClose = true,
}: CenterModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { mounted, state } = usePresence(open, EXIT_MS.panel);

  // Deliberately keyed on `open`, NOT `mounted`: the cleanup releases the body
  // scroll lock and restores focus, and both must happen when the exit STARTS.
  // Keyed on `mounted` the page would stay scroll-locked and focus would land
  // ~180ms after the modal is already visually gone.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) {
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
  }, [open, onClose, closeOnEscape]);

  if (!mounted) return null;

  const exiting = state === "exiting";
  // pointer-events-none while exiting: the dialog is still on screen for the
  // length of the animation, and a closing modal must not be clickable.
  const backdropMotion = exiting
    ? "animate-backdrop-out pointer-events-none"
    : "animate-backdrop-in";

  return createPortal(
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm ${backdropMotion}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`w-full ${maxWidths[maxWidth]} bg-scout-panel border border-scout-hairline-faint rounded-hero shadow-pop flex flex-col max-h-[90vh] outline-none overflow-hidden ${
          exiting ? "animate-modal-out" : "animate-modal-in"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || showClose) && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-scout-hairline-faint shrink-0">
            {title ? (
              <h2 className="text-sm font-medium text-scout-text">{title}</h2>
            ) : (
              <span />
            )}
            {showClose && (
              <button
                onClick={onClose}
                className="p-1 rounded-btn text-scout-muted hover:text-scout-text hover:bg-scout-lift/80 transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="overflow-y-auto flex-1 min-h-0">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
