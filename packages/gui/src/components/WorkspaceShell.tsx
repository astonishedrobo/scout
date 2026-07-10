import type { ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { PanelToggleIcon } from "./ui/PanelToggleIcon";
import { headerIconButtonClass } from "./ui/headerControls";
import { useMediaQuery } from "../hooks/usePanelPrefs";

interface WorkspaceShellProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  sidebar: ReactNode;
  headerActions?: ReactNode;
  sessionTitle?: string;
  banners?: ReactNode;
  children: ReactNode;
  artifactPanel?: ReactNode;
  artifactOpen?: boolean;
  artifactDefaultSize?: number;
  artifactMinSize?: number;
  artifactMaxSize?: number;
  onArtifactResize?: (size: number) => void;
}

export function WorkspaceShell({
  sidebarCollapsed,
  onToggleSidebar,
  sidebar,
  headerActions,
  sessionTitle,
  banners,
  children,
  artifactPanel,
  artifactOpen,
  artifactDefaultSize = 38,
  artifactMinSize = 20,
  artifactMaxSize = 70,
  onArtifactResize,
}: WorkspaceShellProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isMobile = !isDesktop;
  const showSidebarOverlay = isMobile && !sidebarCollapsed;
  const sidebarHidden = sidebarCollapsed && isDesktop;

  return (
    <div className="h-screen flex overflow-hidden bg-transparent text-scout-text">
      {showSidebarOverlay && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={onToggleSidebar}
        />
      )}

      <aside
        className={`
          fixed lg:relative z-30 h-full shrink-0 glass-chrome border-r border-scout-hairline-faint
          transition-[width,transform] duration-200 ease-in-out overflow-hidden
          ${sidebarHidden ? "w-0 lg:w-0" : "w-[252px]"}
          ${isMobile ? (sidebarCollapsed ? "-translate-x-full" : "translate-x-0") : "translate-x-0"}
        `}
      >
        {!sidebarHidden && sidebar}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-scout-hairline-faint bg-scout-canvas px-3.5">
          <button
            onClick={onToggleSidebar}
            className={headerIconButtonClass}
            title={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
          >
            <PanelToggleIcon open={!sidebarCollapsed} side="left" size={16} />
          </button>
          {sessionTitle && (
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-scout-text/90 truncate flex-1 min-w-0">
              {sessionTitle}
            </span>
          )}
          {!sessionTitle && <div className="flex-1" />}
          {headerActions && (
            <div className="flex items-center gap-1.5 shrink-0">{headerActions}</div>
          )}
        </header>

        {banners}

        {isDesktop ? (
          /* The Group and chat Panel are ALWAYS mounted — toggling the side
             panel must not move the chat subtree in the React tree, or the
             composer (and all its draft state) unmounts and resets. */
          <Group orientation="horizontal" className="flex-1 min-h-0">
            {/* react-resizable-panels v4 treats bare numbers as PIXELS —
                sizes must be percentage strings or the panel renders ~38px wide. */}
            <Panel id="chat" defaultSize={`${100 - artifactDefaultSize}%`} minSize="30%">
              <div className="h-full flex flex-col min-h-0 bg-transparent">
                {children}
              </div>
            </Panel>
            {artifactOpen && artifactPanel && (
              <>
                <Separator className="-mx-px w-px shrink-0 cursor-col-resize bg-scout-hairline-faint transition-colors hover:w-1 hover:bg-scout-muted/45 active:bg-scout-muted" />
                <Panel
                  id="artifact"
                  defaultSize={`${artifactDefaultSize}%`}
                  minSize={`${artifactMinSize}%`}
                  maxSize={`${artifactMaxSize}%`}
                  className="bg-transparent"
                  onResize={(size) => onArtifactResize?.(size.asPercentage)}
                >
                  {artifactPanel}
                </Panel>
              </>
            )}
          </Group>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 relative bg-transparent">
            {children}
            {artifactOpen && artifactPanel && (
              <div className="absolute inset-0 z-40 bg-scout-canvas">{artifactPanel}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
