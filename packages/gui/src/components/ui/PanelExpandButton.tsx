import { Maximize2, Minimize2 } from "lucide-react";
import { IconButton } from "./IconButton";

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
    <IconButton
      onClick={onToggle}
      label={expanded ? "Restore panel size" : "Expand panel"}
      aria-pressed={expanded}
      className="hidden lg:inline-flex"
    >
      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </IconButton>
  );
}
