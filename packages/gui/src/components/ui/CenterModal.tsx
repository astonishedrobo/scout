import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";
import { usePresence } from "../../hooks/usePresence";
import { useDialogShell } from "../../hooks/useDialogShell";
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

  // Initial focus, scroll lock, focus restore, Escape and Tab containment all
  // live in useDialogShell so this shell and RightDrawer cannot diverge.
  useDialogShell(open, panelRef, onClose, closeOnEscape);

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
              <h2 className="text-label font-medium text-scout-text">{title}</h2>
            ) : (
              <span />
            )}
            {showClose && (
              <IconButton label="Close" onClick={onClose}>
                <X size={18} />
              </IconButton>
            )}
          </div>
        )}
        <div className="overflow-y-auto flex-1 min-h-0">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
