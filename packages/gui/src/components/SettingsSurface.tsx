import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cpu,
  Gauge,
  Keyboard,
  MessageSquareText,
  Palette,
  Plug,
  Settings as SettingsIcon,
  Shield,
  Sliders,
  Upload,
  Users,
} from "lucide-react";
import { SettingsShell, type NavGroup } from "./ui";
import { GeneralSection } from "./settings/GeneralSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { PreferencesSection } from "./settings/PreferencesSection";
import { MemoriesSection } from "./settings/MemoriesSection";
import { ShortcutsSection } from "./settings/ShortcutsSection";
import { ConnectionsSection } from "./settings/ConnectionsSection";
import { ModelsSection } from "./settings/ModelsSection";
import { SharedFilesSection } from "./settings/admin/SharedFilesSection";
import { UsersSection } from "./settings/admin/UsersSection";
import { ExecutionSection } from "./settings/admin/ExecutionSection";
import { McpSection } from "./settings/admin/McpSection";
import { ConfigurationSection } from "./settings/admin/ConfigurationSection";
import type { SectionProps, StatusMessage } from "./settings/shared";

/**
 * Every settings section, in one surface.
 *
 * Settings and Admin used to be two components with two hand-rolled shells that
 * agreed on nothing, so the same control appeared two ways depending on which
 * one you opened. They are now one nav with one row language; the admin group is
 * gated on `isAdmin` and hidden entirely otherwise.
 */
export type SettingsSectionId =
  | "general"
  | "appearance"
  | "preferences"
  | "memories"
  | "shortcuts"
  | "connections"
  | "models"
  | "files"
  | "users"
  | "execution"
  | "mcp"
  | "config";

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: React.ReactNode;
  keywords?: string[];
  group: "personal" | "integrations" | "workspace";
  /** Rendered only when this returns true. */
  when?: (ctx: { isMultiUser: boolean; isAdmin: boolean }) => boolean;
  render: (props: SectionProps) => React.ReactNode;
}

const SECTIONS: SectionDef[] = [
  {
    id: "general",
    label: "General",
    icon: <SettingsIcon size={15} />,
    keywords: ["permissions", "access", "speed", "panel", "suggestions", "version", "about"],
    group: "personal",
    render: (p) => <GeneralSection {...p} />,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: <Palette size={15} />,
    keywords: ["theme", "dark", "light", "soft", "color", "density", "motion"],
    group: "personal",
    render: () => <AppearanceSection />,
  },
  {
    id: "preferences",
    label: "Preferences",
    icon: <MessageSquareText size={15} />,
    keywords: ["instructions", "tone", "response", "style"],
    group: "personal",
    render: (p) => <PreferencesSection {...p} />,
  },
  {
    id: "memories",
    label: "Memories",
    icon: <Sliders size={15} />,
    keywords: ["memory", "MEMORY.md", "remember", "facts"],
    group: "personal",
    render: (p) => <MemoriesSection {...p} />,
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: <Keyboard size={15} />,
    keywords: ["keys", "hotkeys", "bindings"],
    group: "personal",
    render: () => <ShortcutsSection />,
  },
  {
    id: "connections",
    label: "Connections",
    icon: <Plug size={15} />,
    keywords: ["mcp", "integrations", "tools", "tokens"],
    group: "integrations",
    // Per-user integrations only exist in server mode.
    when: ({ isMultiUser }) => isMultiUser,
    render: (p) => <ConnectionsSection {...p} />,
  },
  {
    id: "models",
    label: "Models & agent",
    icon: <Cpu size={15} />,
    keywords: ["provider", "api key", "temperature", "python", "timeout", "llm"],
    group: "integrations",
    // Writes global config, which is 403 in server mode.
    when: ({ isMultiUser }) => !isMultiUser,
    render: (p) => <ModelsSection {...p} />,
  },
  {
    id: "files",
    label: "Shared files",
    icon: <Upload size={15} />,
    keywords: ["upload", "shared", "data"],
    group: "workspace",
    when: ({ isAdmin }) => isAdmin,
    render: (p) => <SharedFilesSection {...p} />,
  },
  {
    id: "users",
    label: "Users & access",
    icon: <Users size={15} />,
    keywords: ["roles", "permissions", "capacity", "admission"],
    group: "workspace",
    when: ({ isAdmin }) => isAdmin,
    render: (p) => <UsersSection {...p} />,
  },
  {
    id: "execution",
    label: "Execution",
    icon: <Gauge size={15} />,
    keywords: ["sandbox", "health", "worker", "isolation", "metrics", "queue"],
    group: "workspace",
    when: ({ isAdmin }) => isAdmin,
    render: (p) => <ExecutionSection {...p} />,
  },
  {
    id: "mcp",
    label: "MCP tools",
    icon: <Plug size={15} />,
    keywords: ["mcp", "servers", "integrations", "tool policy"],
    group: "workspace",
    when: ({ isAdmin }) => isAdmin,
    render: (p) => <McpSection {...p} />,
  },
  {
    id: "config",
    label: "Configuration",
    icon: <Shield size={15} />,
    keywords: ["config.yaml", "deployment", "reload", "effective"],
    group: "workspace",
    when: ({ isAdmin }) => isAdmin,
    render: (p) => <ConfigurationSection {...p} />,
  },
];

const GROUP_LABELS: Record<SectionDef["group"], string> = {
  personal: "Personal",
  integrations: "Integrations",
  workspace: "Workspace",
};

const TITLES: Record<string, { title: string; subtitle?: string }> = {
  general: { title: "General", subtitle: "Permissions and interface defaults" },
  appearance: { title: "Appearance", subtitle: "Theme and display" },
  preferences: { title: "Preferences", subtitle: "How Scout should respond" },
  memories: { title: "Memories", subtitle: "What Scout remembers about your work" },
  shortcuts: { title: "Keyboard shortcuts", subtitle: "Every binding in the app" },
  connections: { title: "Connections", subtitle: "Manage tools, integrations, and MCPs" },
  models: { title: "Models & agent", subtitle: "Providers and agent tuning" },
  files: { title: "Shared files", subtitle: "Readable by every user's agent" },
  users: { title: "Users & access", subtitle: "Who can do what, and how much at once" },
  execution: { title: "Execution", subtitle: "Sandbox health and turn capacity" },
  mcp: { title: "MCP tools", subtitle: "Servers published to this workspace" },
  config: { title: "Configuration", subtitle: "The deployment's effective settings" },
};

export function SettingsSurface({
  open,
  baseUrl,
  token,
  isMultiUser = false,
  isAdmin = false,
  initialSection,
  onSectionChange,
  onClose,
}: {
  open: boolean;
  baseUrl: string;
  token?: string | null;
  isMultiUser?: boolean;
  isAdmin?: boolean;
  initialSection?: string | null;
  onSectionChange?: (id: SettingsSectionId) => void;
  onClose: () => void;
}) {
  const visible = useMemo(
    () => SECTIONS.filter((s) => !s.when || s.when({ isMultiUser, isAdmin })),
    [isMultiUser, isAdmin],
  );

  const [section, setSection] = useState<SettingsSectionId>(visible[0]?.id ?? "general");
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const select = useCallback(
    (id: string) => {
      setStatus(null);
      setSection(id as SettingsSectionId);
      onSectionChange?.(id as SettingsSectionId);
    },
    [onSectionChange],
  );

  useEffect(() => {
    if (!open || !initialSection) return;
    if (visible.some((s) => s.id === initialSection)) setSection(initialSection as SettingsSectionId);
  }, [open, initialSection, visible]);

  // A section can stop being available (mode change, or a deep link to a section
  // this user cannot see) — fall back rather than render nothing.
  useEffect(() => {
    if (visible.length === 0) return;
    if (!visible.some((s) => s.id === section)) select(visible[0].id);
  }, [visible, section, select]);

  // Transient confirmations should not linger; errors stay until the next action.
  useEffect(() => {
    if (!status || status.tone === "error") return;
    const t = window.setTimeout(() => setStatus(null), 3000);
    return () => window.clearTimeout(t);
  }, [status]);

  const groups: NavGroup[] = useMemo(() => {
    const order: SectionDef["group"][] = ["personal", "integrations", "workspace"];
    return order
      .map((group) => ({
        label: GROUP_LABELS[group],
        sections: visible
          .filter((s) => s.group === group)
          .map((s) => ({ id: s.id, label: s.label, icon: s.icon, keywords: s.keywords })),
      }))
      .filter((g) => g.sections.length > 0);
  }, [visible]);

  const active = visible.find((s) => s.id === section) ?? visible[0];
  const meta = TITLES[active?.id ?? "general"] ?? { title: "Settings" };
  const sectionProps: SectionProps = { baseUrl, token, isMultiUser, setStatus };

  return (
    <SettingsShell
      open={open}
      onClose={onClose}
      title={meta.title}
      subtitle={meta.subtitle}
      groups={groups}
      section={active?.id ?? "general"}
      onSectionChange={select}
      status={status}
    >
      {active?.render(sectionProps)}
    </SettingsShell>
  );
}
