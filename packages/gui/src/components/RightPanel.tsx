import { useRef, useState, type ReactNode } from "react";
import { Bot, FolderTree, GitCompareArrows } from "lucide-react";
import { PanelTabs, type PanelTab } from "./ui/PanelTabs";
import { PanelExpandButton } from "./ui/PanelExpandButton";
import { IconButton } from "./ui/IconButton";
import { AnchoredPopover } from "./ui/AnchoredPopover";
import { PanelLauncher, type LauncherItem } from "./PanelLauncher";
import { PanelToggleIcon } from "./ui/PanelToggleIcon";
import { ICON_SIZE } from "./ui/iconSystem";
import { FileTypeIcon } from "./ui/FileTypeIcon";
import type { OpenTab, RightPanelTab } from "../hooks/useRightPanelTabs";

/** Tab label and icon for a surface, with the surface's own title winning. */
function presentation(tab: RightPanelTab, title?: string): { label: string; icon: ReactNode } {
  switch (tab.kind) {
    case "files":
      return {
        label: title ?? "Files",
        icon: title
          ? <FileTypeIcon name={title} size={ICON_SIZE.feature} />
          : <FolderTree size={ICON_SIZE.feature} />,
      };
    case "agents":
      return { label: title ?? "Agents", icon: <Bot size={ICON_SIZE.feature} /> };
    case "review":
      return {
        label: title ?? (tab.changeSet.undone ? "Undo applied" : "Review"),
        icon: <GitCompareArrows size={ICON_SIZE.feature} />,
      };
    case "artifact":
      return {
        label: title ?? tab.artifact.title,
        icon: <FileTypeIcon name={tab.artifact.name || tab.artifact.path} size={ICON_SIZE.feature} />,
      };
  }
}

/**
 * The right panel's frame: the tab strip, the pane-level expand/close controls,
 * and the launcher.
 *
 * The surfaces themselves supply their own `PanelBreadcrumb` row, so the layout
 * is exactly two chrome bands — strip, then breadcrumb — and no surface needs to
 * hand its internal state upward to be rendered as a header.
 *
 * Every open tab stays mounted; inactive ones are hidden. That is the point of
 * the whole change: the file tree's expansion state and a diff's scroll position
 * survive switching away and back.
 */
export function RightPanel({
  tabs,
  activeKey,
  onActivate,
  onCloseTab,
  onCloseAll,
  launcherItems,
  expanded,
  onToggleExpand,
  renderSurface,
}: {
  tabs: OpenTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onCloseTab: (key: string) => void;
  onCloseAll: () => void;
  launcherItems: LauncherItem[];
  expanded: boolean;
  onToggleExpand: () => void;
  renderSurface: (tab: OpenTab) => ReactNode;
}) {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  const stripTabs: PanelTab[] = tabs.map((open) => {
    const { label, icon } = presentation(open.tab, open.title);
    return { key: open.key, label, icon, title: label };
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-scout-canvas">
      <PanelTabs
        tabs={stripTabs}
        activeKey={activeKey}
        onActivate={onActivate}
        onClose={onCloseTab}
        onAdd={() => setLauncherOpen((open) => !open)}
        addRef={addRef}
        trailing={
          <>
            <PanelExpandButton expanded={expanded} onToggle={onToggleExpand} />
            <IconButton
              label="Close side panel (Alt+P)"
              onClick={onCloseAll}
              aria-expanded={true}
            >
              <PanelToggleIcon open side="right" size={14} />
            </IconButton>
          </>
        }
      />

      <AnchoredPopover
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        anchorRef={addRef}
        placement="bottom-start"
      >
        <PanelLauncher
          items={launcherItems}
          variant="menu"
          onDismiss={() => setLauncherOpen(false)}
        />
      </AnchoredPopover>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <PanelLauncher items={launcherItems} />
        ) : (
          tabs.map((open) => (
            <div
              key={open.key}
              // `hidden` rather than unmounting. Note this also drops the
              // subtree out of any focus trap, since `focusableWithin` filters
              // on `offsetParent` — which is what we want.
              className={`absolute inset-0 flex min-h-0 flex-col ${
                open.key === activeKey ? "" : "hidden"
              }`}
            >
              {renderSurface(open)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
