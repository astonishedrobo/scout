import type { ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";
import { PanelExpandButton } from "./PanelExpandButton";

/**
 * The 52px panel header, once.
 *
 * All five panels claimed `h-[52px]` and none of them matched: four paddings,
 * three gaps, two backgrounds, four title treatments, three icon-button radii,
 * four close-icon sizes, and `aria-label` on the close button in only two of
 * them. Two of those panels render on screen at the same time
 * (ArtifactPanel inside FileExplorerPanel), so the divergence was visible.
 */
export function PanelHeader({
  icon,
  title,
  subtitle,
  actions,
  expanded,
  onToggleExpand,
  onClose,
  closeLabel = "Close",
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Panel-specific controls, placed before expand/close. */
  actions?: ReactNode;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex h-[52px] shrink-0 items-center gap-2.5 border-b border-scout-hairline-faint bg-scout-canvas px-3.5 ${className}`}
    >
      {icon && <span className="flex shrink-0 items-center text-scout-muted">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-label font-semibold text-scout-text">{title}</div>
        {subtitle && <div className="truncate text-micro text-scout-muted">{subtitle}</div>}
      </div>
      {actions}
      {onToggleExpand && <PanelExpandButton expanded={!!expanded} onToggle={onToggleExpand} />}
      {onClose && (
        <IconButton label={closeLabel} onClick={onClose}>
          <X size={17} />
        </IconButton>
      )}
    </div>
  );
}
