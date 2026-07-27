import { IconButton } from "./IconButton";

function PanelSizeGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {expanded ? (
        <>
          <path d="M13.5 6.5h-4v-4" />
          <path d="M2.5 9.5h4v4" />
        </>
      ) : (
        <>
          <path d="M9.5 2.5h4v4" />
          <path d="M6.5 13.5h-4v-4" />
        </>
      )}
    </svg>
  );
}

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
      <PanelSizeGlyph expanded={expanded} />
    </IconButton>
  );
}
