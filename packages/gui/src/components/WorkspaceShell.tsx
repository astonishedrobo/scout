import type { ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { PanelLeft, PanelLeftClose } from "lucide-react";
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
  onArtifactResize?: (size: number) => void;
  isConnected?: boolean;
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
  onArtifactResize,
  isConnected,
}: WorkspaceShellProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isMobile = !isDesktop;
  const showSidebarOverlay = isMobile && !sidebarCollapsed;
  const sidebarHidden = sidebarCollapsed && isDesktop;

  return (
    <div className="h-screen flex overflow-hidden bg-scout-canvas text-scout-text">
      {showSidebarOverlay && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={onToggleSidebar}
        />
      )}

      <aside
        className={`
          fixed lg:relative z-30 h-full shrink-0 bg-scout-canvas/95 backdrop-blur-xl
          transition-[width,transform] duration-200 ease-in-out overflow-hidden
          ${sidebarHidden ? "w-0 lg:w-0" : "w-[260px]"}
          ${isMobile ? (sidebarCollapsed ? "-translate-x-full" : "translate-x-0") : "translate-x-0"}
        `}
      >
        {!sidebarHidden && sidebar}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="flex items-center h-14 px-4 bg-scout-canvas/85 backdrop-blur-xl border-b border-scout-hairline-faint shrink-0 gap-3">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-btn hover:bg-scout-lift/80 text-scout-muted hover:text-scout-text transition-colors"
            title={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
          >
            {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          </button>
          {sessionTitle && (
            <span className="text-sm font-medium text-scout-text/90 truncate flex-1 min-w-0">
              {sessionTitle}
            </span>
          )}
          {!sessionTitle && <div className="flex-1" />}
          {isConnected !== undefined && (
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-pill text-caption font-medium border ${
                isConnected
                  ? "border-scout-success/20 bg-transparent text-scout-muted"
                  : "border-scout-hairline-faint bg-transparent text-scout-muted"
              }`}
              title={
                isConnected
                  ? "Connected to the Scout server"
                  : "Connection lost — messages can't be sent until it's restored"
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-scout-success" : "bg-scout-muted"}`}
              />
              {isConnected ? "Connected" : "Offline"}
            </span>
          )}
          {headerActions && (
            <div className="flex items-center gap-1 shrink-0">{headerActions}</div>
          )}
        </header>

        {banners}

        {artifactOpen && artifactPanel && isDesktop ? (
          <Group orientation="horizontal" className="flex-1 min-h-0">
            {/* react-resizable-panels v4 treats bare numbers as PIXELS —
                sizes must be percentage strings or the panel renders ~38px wide. */}
            <Panel id="chat" defaultSize={`${100 - artifactDefaultSize}%`} minSize="30%">
              <div className="h-full flex flex-col min-h-0 bg-scout-canvas">
                {children}
              </div>
            </Panel>
            <Separator className="w-1 -mx-px shrink-0 cursor-col-resize bg-scout-hairline-faint hover:bg-scout-muted/60 active:bg-scout-muted transition-colors" />
            <Panel
              id="artifact"
              defaultSize={`${artifactDefaultSize}%`}
              minSize="20%"
              maxSize="55%"
              className="bg-scout-canvas"
              onResize={(size) => onArtifactResize?.(size.asPercentage)}
            >
              {artifactPanel}
            </Panel>
          </Group>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 relative bg-scout-canvas">
            {children}
            {artifactOpen && artifactPanel && isMobile && (
              <div className="absolute inset-0 z-40 bg-scout-canvas">{artifactPanel}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
