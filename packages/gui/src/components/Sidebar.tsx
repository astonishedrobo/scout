import {
  Plus,
  Settings,
  HelpCircle,
  FolderOpen,
  CircleUserRound,
  Sun,
  Moon,
  AlertTriangle,
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
import { PixelMap } from "./PixelArt";

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

function bucketLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = date.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 86_400_000) return "Yesterday";
  if (t >= startOfToday - 6 * 86_400_000) return "Previous 7 days";
  return "Older";
}

function groupSessions(sessions: SessionMeta[]) {
  const groups: { label: string; items: SessionMeta[] }[] = [];
  for (const s of sessions) {
    const label = bucketLabel(s.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
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
    <div className="flex h-full w-[252px] flex-col overflow-hidden bg-transparent">
      <div className="px-3 pb-2.5">
        <div className="mb-2 flex h-12 items-center justify-between">
          <div className="min-w-0 font-display text-[16px] font-semibold tracking-[-0.035em] text-scout-text">Scout</div>
          <button
            onClick={onToggleTheme}
            className="rounded-btn p-2 text-scout-muted transition-colors hover:bg-scout-lift/80 hover:text-scout-text"
            title={theme === "light" ? "Return to your selected dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
          </button>
        </div>

        <Button
          onClick={onNewChat}
          variant="filledInverse"
          surface="panel"
          fullWidth
          size="default"
        >
          <Plus size={16} />
          New chat
        </Button>
      </div>

      {!hasModels && isConnected && !isMultiUser && (
        <div className="mx-4 mb-3 p-3 rounded-card bg-scout-warning-muted border border-scout-warning/15">
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

      <div className="flex-1 overflow-y-auto px-3 pt-1">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-2 pt-10 text-center">
            <PixelMap size={40} />
            <p className="text-caption text-scout-muted leading-relaxed">
              Uncharted territory.
              <br />
              Start a chat and it will show up here.
            </p>
            <button
              onClick={onNewChat}
              className="text-caption font-semibold text-scout-text underline underline-offset-2 hover:opacity-80"
            >
              Start your first chat
            </button>
          </div>
        ) : (
          groupSessions(sessions).map((group) => (
          <div key={group.label} className="mb-1.5">
          <p className="px-1 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-scout-muted/65">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((s) => (
              <div
                key={s.sessionId}
                className={`group flex cursor-pointer items-center rounded-btn px-2.5 py-2 text-sm transition-colors
                  ${s.sessionId === currentSessionId
                    ? "bg-scout-lift"
                    : "hover:bg-scout-lift/65"
                  }`}
                onClick={() => onResumeSession(s.sessionId)}
              >
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
          </div>
          ))
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
          className="w-[calc(100%-16px)] mx-2 my-2 flex items-center gap-2.5 px-2.5 py-2 rounded-btn text-sm text-scout-text hover:bg-scout-input-bg/80 border border-transparent hover:border-scout-hairline-faint transition-all"
          title="Account & app menu"
        >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill border border-scout-hairline-faint bg-scout-input-bg">
            {username ? (
              <span className="text-caption font-semibold text-scout-text uppercase">
                {username.charAt(0)}
              </span>
            ) : (
              <CircleUserRound size={13} className="text-scout-muted" />
            )}
          </div>
          <span className="flex-1 text-left text-sm font-medium truncate capitalize">
            {username ?? "Account"}
          </span>
          <ChevronUp
            size={14}
            className={`text-scout-muted transition-transform ${bottomExpanded ? "rotate-180" : ""}`}
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
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-btn text-sm font-medium text-scout-text hover:bg-scout-lift/80 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}
