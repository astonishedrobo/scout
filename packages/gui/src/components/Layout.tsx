import type { ReactNode } from "react";
import { Menu, X, PanelLeftClose, PanelLeft } from "lucide-react";

interface LayoutProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  sidebar: ReactNode;
  children: ReactNode;
}

export function Layout({
  sidebarOpen,
  onToggleSidebar,
  sidebar,
  children,
}: LayoutProps) {
  return (
    <div className="h-screen flex overflow-hidden bg-scout-bg">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={onToggleSidebar}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:relative z-30 h-full w-64
          bg-scout-sidebar-bg border-r border-scout-border
          transition-transform duration-200 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0 lg:w-0 lg:border-0 lg:overflow-hidden"}
        `}
      >
        {sidebar}
      </aside>

      {/* Main area */}
      <main className="flex-1 flex flex-col min-w-0 bg-scout-bg">
        {/* Top bar with sidebar toggle */}
        <div className="flex items-center h-11 px-3 border-b border-scout-border">
          <button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-md hover:bg-scout-surface-hover text-scout-text-secondary transition-colors"
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
          </button>
        </div>

        {children}
      </main>
    </div>
  );
}
