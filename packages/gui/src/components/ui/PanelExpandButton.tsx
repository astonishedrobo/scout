import { Maximize2, Minimize2 } from "lucide-react";

/** Expand the side panel over the chat column (and back). Desktop only —
 * on mobile the panel is already a fullscreen overlay. */
export function PanelExpandButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-btn text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text lg:inline-flex"
      title={expanded ? "Restore panel size" : "Expand panel"}
      aria-label={expanded ? "Restore panel size" : "Expand panel"}
      aria-pressed={expanded}
    >
      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  );
}
