import {
  Plus,
  Settings,
  HelpCircle,
  FolderOpen,
  Sparkles,
  Sun,
  Moon,
  AlertTriangle,
  MessageSquare,
  Trash2,
  ChevronUp,
} from "lucide-react";
import { useState } from "react";
import type { Theme } from "../hooks/useTheme";
import type { SessionMeta } from "../hooks/useSessions";

interface SidebarProps {
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenInit: () => void;
  onOpenHelp: () => void;
  isConnected: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  sessions: SessionMeta[];
  currentSessionId: string | null;
  onResumeSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  hasModels: boolean;
  onLogout?: () => void;
  username?: string;
  isMultiUser?: boolean;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function Sidebar({
  onNewChat,
  onOpenSettings,
  onOpenInit,
  onOpenHelp,
  isConnected,
  theme,
  onToggleTheme,
  sessions,
  currentSessionId,
  onResumeSession,
  onDeleteSession,
  hasModels,
  onLogout,
  username,
  isMultiUser,
}: SidebarProps) {
  const [bottomExpanded, setBottomExpanded] = useState(false);

  return (
    <div className="flex flex-col h-full bg-scout-sidebar-bg">
      {/* ── Top: Logo + New Chat ────────────────────────────── */}
      <div className="px-3 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-scout-accent" />
            <span className="font-semibold text-scout-text-primary text-[15px]">Scout</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onToggleTheme}
              className="p-1.5 rounded-md hover:bg-scout-surface-hover text-scout-text-secondary transition-colors"
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <span
              className={`w-2 h-2 rounded-full ${isConnected ? "bg-scout-success" : "bg-scout-error"}`}
            />
          </div>
        </div>

        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm
                     text-scout-text-primary hover:bg-scout-sidebar-hover transition-colors"
        >
          <Plus size={16} className="text-scout-text-secondary" />
          New chat
        </button>
      </div>

      {/* ── No LLM warning ──────────────────────────────────── */}
      {!hasModels && isConnected && !isMultiUser && (
        <div className="mx-3 mb-2 p-2.5 rounded-lg bg-scout-warning-muted border border-scout-warning/20">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-scout-warning mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs font-medium text-scout-text-primary">No LLM configured</p>
              <p className="text-xs text-scout-text-secondary mt-0.5">
                Open{" "}
                <button onClick={onOpenSettings} className="text-scout-accent hover:underline">
                  Settings
                </button>{" "}
                to add an API key.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Sessions list ───────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 pt-1">
        {sessions.length > 0 && (
          <p className="text-[11px] uppercase tracking-wider text-scout-text-secondary/70 px-2 py-1.5 font-medium">
            Recents
          </p>
        )}
        {sessions.length === 0 ? (
          <p className="text-xs text-scout-text-secondary/60 px-2 py-6 text-center">
            Your conversations will appear here
          </p>
        ) : (
          <div className="space-y-px">
            {sessions.map((s) => (
              <div
                key={s.sessionId}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-sm
                  ${s.sessionId === currentSessionId
                    ? "bg-scout-sidebar-hover text-scout-text-primary"
                    : "text-scout-text-secondary hover:bg-scout-sidebar-hover hover:text-scout-text-primary"
                  }`}
                onClick={() => onResumeSession(s.sessionId)}
              >
                <MessageSquare size={14} className="flex-shrink-0 opacity-50" />
                <span className="flex-1 truncate">{s.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteSession(s.sessionId); }}
                  className="opacity-0 group-hover:opacity-50 hover:!opacity-100 p-0.5 rounded transition-opacity"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom bar (expandable like Claude) ─────────────── */}
      <div className="border-t border-scout-border">
        {/* Expanded section */}
        {bottomExpanded && (
          <div className="px-2 pt-2 pb-1 space-y-0.5">
            {username && (
              <div className="px-3 py-1 text-xs text-scout-text-secondary/60 uppercase font-bold tracking-wider">
                {username}
              </div>
            )}
            <BottomNavItem icon={<Settings size={15} />} label="Settings" onClick={() => { setBottomExpanded(false); onOpenSettings(); }} />
            {!isMultiUser && (
              <BottomNavItem icon={<FolderOpen size={15} />} label="Init Workspace" onClick={() => { setBottomExpanded(false); onOpenInit(); }} />
            )}
            <BottomNavItem icon={<HelpCircle size={15} />} label="Get help" onClick={() => { setBottomExpanded(false); onOpenHelp(); }} />
            {onLogout && (
              <BottomNavItem icon={<Trash2 size={15} />} label="Logout" onClick={() => { setBottomExpanded(false); onLogout(); }} />
            )}
          </div>
        )}

        {/* Clickable bottom bar */}
        <button
          onClick={() => setBottomExpanded((p) => !p)}
          className="w-full flex items-center gap-2 px-4 py-3
                     text-sm text-scout-text-secondary hover:text-scout-text-primary
                     hover:bg-scout-sidebar-hover transition-colors"
        >
          <div className="w-6 h-6 rounded-full bg-scout-accent/20 flex items-center justify-center flex-shrink-0">
            <Sparkles size={12} className="text-scout-accent" />
          </div>
          <span className="flex-1 text-left text-xs truncate">Scout</span>
          <ChevronUp
            size={14}
            className={`transition-transform ${bottomExpanded ? "" : "rotate-180"}`}
          />
        </button>
      </div>
    </div>
  );
}

function BottomNavItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm
                 text-scout-text-secondary hover:bg-scout-sidebar-hover
                 hover:text-scout-text-primary transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}
