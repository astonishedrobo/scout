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
  Pencil,
  Trash2,
  ChevronUp,
  Shield,
  LogOut,
} from "lucide-react";
import { useState } from "react";
import type { Theme } from "../hooks/useTheme";
import type { SessionMeta } from "../hooks/useSessions";
import { CenterModal } from "./ui/CenterModal";
import { Button } from "./ui/Button";

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
  onRenameSession: (id: string, title: string) => Promise<void>;
  onDeleteSession: (id: string) => void;
  hasModels: boolean;
  onLogout?: () => void;
  username?: string;
  isMultiUser?: boolean;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
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
  onRenameSession,
  onDeleteSession,
  hasModels,
  onLogout,
  username,
  isMultiUser,
  isAdmin,
  onOpenAdmin,
}: SidebarProps) {
  const [bottomExpanded, setBottomExpanded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionMeta | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const saveTitle = async (session: SessionMeta) => {
    const title = editingTitle.trim();
    if (!title || title === session.title) {
      setEditingId(null);
      return;
    }
    try {
      await onRenameSession(session.sessionId, title);
      setEditingId(null);
    } catch (err) {
      console.error("Failed to rename session:", err);
    }
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      onDeleteSession(deleteTarget.sessionId);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex flex-col h-full w-[260px] bg-transparent border-r border-scout-hairline-faint overflow-hidden">
      <div className="px-4 pb-3">
        <div className="flex items-center justify-between h-12 mb-3">
          <span className="inline-flex items-center gap-2 font-semibold text-scout-text text-[15px] tracking-[-0.02em]">
            <span className="h-2 w-2 rounded-full bg-scout-text/80" />
            Scout
          </span>
          <button
            onClick={onToggleTheme}
            className="p-2 rounded-btn hover:bg-scout-lift/80 text-scout-muted hover:text-scout-text transition-colors"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>

        <Button
          onClick={onNewChat}
          accent="contrast"
          variant="filled"
          surface="panel"
          fullWidth
          size="default"
        >
          <Plus size={16} />
          New chat
        </Button>
      </div>

      {!hasModels && isConnected && !isMultiUser && (
        <div className="mx-4 mb-3 p-3 rounded-2xl bg-scout-warning-muted border border-scout-warning/15">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-scout-warning mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-medium text-scout-text">No LLM configured</p>
              <p className="text-caption text-scout-muted mt-0.5">
                Open{" "}
                <button onClick={onOpenSettings} className="underline hover:text-scout-text">
                  Settings
                </button>{" "}
                to add an API key.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 pt-1">
        {sessions.length > 0 && (
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-scout-muted/80 px-1 py-2">
            Recents
          </p>
        )}
        {sessions.length === 0 ? (
          <p className="text-caption text-scout-muted leading-relaxed px-1 pt-2">
            No conversations yet
          </p>
        ) : (
          <div className="space-y-1">
            {sessions.map((s) => (
              <div
                key={s.sessionId}
                className={`group flex items-center gap-2 px-3 py-2.5 rounded-2xl cursor-pointer transition-all text-sm border
                  ${s.sessionId === currentSessionId
                    ? "bg-scout-lift/70 border-scout-hairline-faint shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                    : "bg-transparent border-transparent hover:bg-scout-input-bg/70 hover:border-scout-hairline-faint"
                  }`}
                onClick={() => onResumeSession(s.sessionId)}
              >
                <MessageSquare size={14} className="shrink-0 text-scout-muted" />
                <div className="flex-1 min-w-0">
                  {editingId === s.sessionId ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      maxLength={80}
                      aria-label="Conversation title"
                      className="w-full rounded-md border border-scout-hairline bg-scout-bg px-1.5 py-0.5 text-[13px] font-medium text-scout-text outline-none focus:border-scout-muted"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => void saveTitle(s)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") void saveTitle(s);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <span className="block truncate text-[13px] font-medium text-scout-text/95">{s.title}</span>
                  )}
                  <span className="text-caption text-scout-muted">{timeAgo(s.updatedAt)}</span>
                  {s.parentSessionId && (
                    <button
                      type="button"
                      className="text-caption text-scout-muted hover:text-scout-text underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResumeSession(s.parentSessionId!);
                      }}
                    >
                      ↳ fork of parent
                    </button>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(s.sessionId);
                    setEditingTitle(s.title);
                  }}
                  className="hover-reveal p-2 -m-0.5 rounded-btn text-scout-muted hover:text-scout-text hover:bg-scout-lift"
                  title="Edit title"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(s);
                  }}
                  className="hover-reveal p-2 -m-0.5 rounded-btn text-scout-muted hover:text-scout-error hover:bg-scout-lift"
                  title="Delete session"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-scout-hairline-faint">
        {bottomExpanded && (
          <div className="px-2 pt-2 pb-1 space-y-0.5">
            <BottomNavItem
              icon={<Settings size={15} />}
              label="Settings"
              onClick={() => {
                setBottomExpanded(false);
                onOpenSettings();
              }}
            />
            {!isMultiUser && (
              <BottomNavItem
                icon={<FolderOpen size={15} />}
                label="Init Workspace"
                onClick={() => {
                  setBottomExpanded(false);
                  onOpenInit();
                }}
              />
            )}
            {isAdmin && isMultiUser && (
              <BottomNavItem
                icon={<Shield size={15} />}
                label="Admin"
                onClick={() => {
                  setBottomExpanded(false);
                  onOpenAdmin?.();
                }}
              />
            )}
            <BottomNavItem
              icon={<HelpCircle size={15} />}
              label="Get help"
              onClick={() => {
                setBottomExpanded(false);
                onOpenHelp();
              }}
            />
            {onLogout && (
              <BottomNavItem
                icon={<LogOut size={15} />}
                label="Logout"
                onClick={() => {
                  setBottomExpanded(false);
                  onLogout();
                }}
              />
            )}
          </div>
        )}

        <button
          onClick={() => setBottomExpanded((p) => !p)}
          className="w-[calc(100%-16px)] mx-2 my-2 flex items-center gap-2.5 px-2.5 py-2 rounded-2xl text-sm text-scout-text hover:bg-scout-input-bg/80 border border-transparent hover:border-scout-hairline-faint transition-all"
          title="Account & app menu"
        >
          <div className="w-7 h-7 rounded-pill bg-scout-input-bg border border-scout-hairline-faint flex items-center justify-center shrink-0">
            {username ? (
              <span className="text-caption font-semibold text-scout-text uppercase">
                {username.charAt(0)}
              </span>
            ) : (
              <Sparkles size={12} className="text-scout-muted" />
            )}
          </div>
          <span className="flex-1 text-left text-sm font-medium truncate capitalize">
            {username ?? "Account"}
          </span>
          <ChevronUp
            size={14}
            className={`text-scout-muted transition-transform ${bottomExpanded ? "" : "rotate-180"}`}
          />
        </button>
      </div>

      <CenterModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete conversation"
        maxWidth="sm"
      >
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-scout-muted">
            Delete &ldquo;{deleteTarget?.title}&rdquo;? This cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" surface="panel" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="filled" surface="panel" accent="contrast" onClick={confirmDelete}>
              Delete
            </Button>
          </div>
        </div>
      </CenterModal>
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
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-scout-text hover:bg-scout-lift/80 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}
