// OpenAI-style panel toggle: a panel outline whose inner bar is a full
// divider when the panel is closed and shrinks to a short centered handle
// when it's open. One icon, two states, animated between them — no arrows.
import { Folder, FolderOpen } from "lucide-react";

// Folder toggle for the file tree: crossfades between closed and open folder
// with a little tilt, like the folder is being opened.
export function FolderToggleIcon({ open, size = 16 }: { open: boolean; size?: number }) {
  return (
    <span
      className="relative inline-block"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Folder
        size={size}
        className="absolute inset-0 transition-all duration-200"
        style={{
          opacity: open ? 0 : 1,
          transform: open ? "rotate(-8deg) scale(0.85)" : "rotate(0deg) scale(1)",
        }}
      />
      <FolderOpen
        size={size}
        className="absolute inset-0 transition-all duration-200"
        style={{
          opacity: open ? 1 : 0,
          transform: open ? "rotate(0deg) scale(1)" : "rotate(8deg) scale(0.85)",
        }}
      />
    </span>
  );
}

export function PanelToggleIcon({
  open,
  side = "left",
  size = 18,
}: {
  open: boolean;
  side?: "left" | "right";
  size?: number;
}) {
  const barX = side === "left" ? 5.1 : 12.1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.75"
        y="2.75"
        width="14.5"
        height="12.5"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x={barX}
        y={open ? 6.75 : 4.9}
        width="1.8"
        height={open ? 4.5 : 8.2}
        rx="0.9"
        fill="currentColor"
        style={{ transition: "y 160ms ease, height 160ms ease" }}
      />
    </svg>
  );
}
