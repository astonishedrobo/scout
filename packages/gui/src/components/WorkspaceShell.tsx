import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { PanelToggleIcon } from "./ui/PanelToggleIcon";
import { IconButton } from "./ui/IconButton";
import { useMediaQuery } from "../hooks/usePanelPrefs";
import { PANEL_GLIDE_MS, SETTLE_SLACK_MS } from "../motion";

interface WorkspaceShellProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  sidebar: ReactNode;
  headerActions?: ReactNode;
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  sessionTitle?: string;
  banners?: ReactNode;
  children: ReactNode;
  artifactPanel?: ReactNode;
  artifactOpen?: boolean;
  /** Expand the side panel over the whole content area (chat collapses). */
  artifactExpanded?: boolean;
  artifactDefaultSize?: number;
  artifactMinSize?: number;
  artifactMaxSize?: number;
  onArtifactResize?: (size: number) => void;
}

function ShellHeader({
  sidebarCollapsed,
  onToggleSidebar,
  sessionTitle,
  headerActions,
  rightPanelOpen,
  onToggleRightPanel,
}: Pick<
  WorkspaceShellProps,
  | "sidebarCollapsed"
  | "onToggleSidebar"
  | "sessionTitle"
  | "headerActions"
  | "rightPanelOpen"
  | "onToggleRightPanel"
>) {
  return (
    <header className="flex h-[46px] shrink-0 items-center gap-3 border-b border-scout-hairline-faint bg-scout-canvas px-3">
      <IconButton
        onClick={onToggleSidebar}
        label={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
        aria-expanded={!sidebarCollapsed}
      >
        <PanelToggleIcon open={!sidebarCollapsed} side="left" size={16} />
      </IconButton>
      {sessionTitle && (
        // title: the session name is the only label for the current
        // conversation and it truncates at every narrow width.
        <span
          className="min-w-0 flex-1 truncate text-label font-semibold tracking-[-0.01em] text-scout-text/90"
          title={sessionTitle}
        >
          {sessionTitle}
        </span>
      )}
      {!sessionTitle && <div className="flex-1" />}
      {headerActions && (
        <div className="flex items-center gap-1.5 shrink-0">{headerActions}</div>
      )}
      {!rightPanelOpen && onToggleRightPanel && (
        <IconButton
          onClick={onToggleRightPanel}
          label="Open side panel (Alt+P)"
          aria-expanded={false}
          className="ml-0.5"
        >
          <PanelToggleIcon open={false} side="right" size={16} />
        </IconButton>
      )}
    </header>
  );
}

export function WorkspaceShell({
  sidebarCollapsed,
  onToggleSidebar,
  sidebar,
  headerActions,
  rightPanelOpen,
  onToggleRightPanel,
  sessionTitle,
  banners,
  children,
  artifactPanel,
  artifactOpen,
  artifactExpanded = false,
  artifactDefaultSize = 38,
  artifactMinSize = 20,
  artifactMaxSize = 70,
  onArtifactResize,
}: WorkspaceShellProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isMobile = !isDesktop;
  const showSidebarOverlay = isMobile && !sidebarCollapsed;
  const sidebarHidden = sidebarCollapsed && isDesktop;

  // The side panel stays mounted and glides between 0% and its saved size.
  // Sizes are driven by pinning min==max to the target (imperative setLayout
  // does not reliably apply, but constraint changes always revalidate the
  // layout). The pin + transition class land in the SAME commit — the render-
  // phase state update below re-renders before painting — so the flex-grow
  // change animates. Once open and settled, constraints relax for dragging.
  const openSize = Math.min(Math.max(artifactDefaultSize, artifactMinSize), artifactMaxSize);
  const layoutKey = `${!!artifactOpen}`;
  const prevLayoutRef = useRef(layoutKey);
  const [settled, setSettled] = useState(true);
  if (prevLayoutRef.current !== layoutKey) {
    prevLayoutRef.current = layoutKey;
    if (settled) setSettled(false);
  }
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(
      () => setSettled(true),
      PANEL_GLIDE_MS + SETTLE_SLACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settled]);
  const pinArtifact = !artifactOpen || !settled;
  const artifactTarget = artifactOpen ? openSize : 0;
  // Ignore a stale expanded flag while the panel is closing (App resets it in
  // an effect, one frame later) — otherwise a blank overlay flashes.
  const expandedActive = !!artifactOpen && artifactExpanded;

  return (
    <div className="flex h-dvh overflow-hidden bg-transparent text-scout-text">
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
          ${sidebarHidden ? "w-0 lg:w-0" : "w-[min(252px,85vw)] lg:w-[252px]"}
          ${isMobile ? (sidebarCollapsed ? "-translate-x-full" : "translate-x-0") : "translate-x-0"}
        `}
      >
        {!sidebarHidden && sidebar}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {isDesktop ? (
          /* The Group and chat Panel are ALWAYS mounted — toggling the side
             panel must not move the chat subtree in the React tree, or the
             composer (and all its draft state) unmounts and resets.
             The header lives INSIDE the chat panel so the side panel gets its
             own full-height column with its own top bar (split top bar).
             Panel className lands on an INNER div; the flex sizing lives on
             the outer [data-panel] element. The width transition is therefore
             scoped through the Group: .panels-gliding > [data-panel]. */
          <Group
            orientation="horizontal"
            className={`relative flex-1 min-h-0 ${settled ? "" : "panels-gliding"}`}
            onLayoutChanged={(layout) => {
              // Persist only after the pointer is released. Updating
              // artifactDefaultSize from Panel.onResize changes both panels'
              // defaultSize props mid-drag, which makes react-resizable-panels
              // re-register them and drops the active pointer gesture.
              const size = layout.artifact;
              if (artifactOpen && settled && !expandedActive && size > 0) {
                onArtifactResize?.(size);
              }
            }}
          >
            {/* react-resizable-panels v4 treats bare numbers as PIXELS —
                sizes must be percentage strings or the panel renders ~38px wide. */}
            <Panel
              id="chat"
              defaultSize={artifactOpen ? `${100 - artifactDefaultSize}%` : "100%"}
              minSize="30%"
            >
              <div className="h-full flex flex-col min-h-0 bg-transparent">
                <ShellHeader
                  sidebarCollapsed={sidebarCollapsed}
                  onToggleSidebar={onToggleSidebar}
                  sessionTitle={sessionTitle}
                  headerActions={headerActions}
                  rightPanelOpen={rightPanelOpen}
                  onToggleRightPanel={onToggleRightPanel}
                />
                {banners}
                {children}
              </div>
            </Panel>
            {/* Constant 1px line with an invisible widened hit area — a
                hover width change shifts the line under the cursor and
                makes the first drag miss. */}
            <Separator
              className={
                artifactOpen && !expandedActive
                  ? "relative w-px shrink-0 cursor-col-resize bg-scout-hairline-faint transition-colors hover:bg-scout-muted/45 active:bg-scout-muted before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']"
                  : "w-0 shrink-0 pointer-events-none opacity-0"
              }
            />
            {/* Expanded = the panel content overlays the chat column (Codex-
                style). The inner div escapes its 0-width flex slot (outer
                [data-panel] keeps overflow: visible) and covers the Group,
                so the underlying split is untouched and restore is exact.
                Same DOM node either way — file tree state survives. */}
            <Panel
              id="artifact"
              defaultSize={artifactOpen ? `${artifactDefaultSize}%` : "0%"}
              minSize={pinArtifact ? `${artifactTarget}%` : `${artifactMinSize}%`}
              maxSize={pinArtifact ? `${artifactTarget}%` : `${artifactMaxSize}%`}
              className={
                expandedActive
                  ? "absolute inset-0 z-40 bg-scout-canvas animate-panel-in"
                  : "bg-transparent"
              }
            >
              {artifactPanel ? (
                <div
                  aria-hidden={!artifactOpen}
                  className={`h-full ${
                    artifactOpen
                      ? "animate-backdrop-in"
                      : "invisible pointer-events-none"
                  }`}
                >
                  {artifactPanel}
                </div>
              ) : null}
            </Panel>
          </Group>
        ) : (
          <>
            <ShellHeader
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={onToggleSidebar}
              sessionTitle={sessionTitle}
              headerActions={headerActions}
              rightPanelOpen={rightPanelOpen}
              onToggleRightPanel={onToggleRightPanel}
            />
            {banners}
            <div className="flex-1 flex flex-col min-h-0 relative bg-transparent">
              {children}
              {artifactPanel && (
                <div
                  aria-hidden={!artifactOpen}
                  className={`absolute inset-0 z-40 bg-scout-canvas ${
                    artifactOpen
                      ? "animate-panel-in"
                      : "invisible pointer-events-none"
                  }`}
                >
                  {artifactPanel}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
