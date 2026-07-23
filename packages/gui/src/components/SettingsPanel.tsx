import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Eye, EyeOff, Sun, Moon, Cloud, Plus } from "lucide-react";
import { useTheme, type Theme } from "../hooks/useTheme";
import { Button } from "./ui/Button";
import { APP_VERSION, SHORTCUTS } from "../appMeta";
import { PixelBook } from "./PixelArt";

interface SettingsPanelProps {
  open: boolean;
  baseUrl: string;
  isMultiUser?: boolean;
  token?: string | null;
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  onClose: () => void;
}

type Tab = "general" | "models" | "memories" | "integrations";

interface ProviderState {
  name: string;
  api_key: string;
  api_base: string;
  models: string[];
}

interface DesktopEnvOption {
  label: string;
  value: string;
  type: "venv" | "conda" | "system";
}

export function SettingsPanel({ open, baseUrl, isMultiUser, token, initialTab, onTabChange, onClose }: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const [newMemory, setNewMemory] = useState("");
  const [memoryEntries, setMemoryEntries] = useState<string[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [useMemories, setUseMemories] = useState(true);
  const [generateMemories, setGenerateMemories] = useState(true);
  const [memoryPreferenceStatus, setMemoryPreferenceStatus] = useState("");
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [agentModel, setAgentModel] = useState("");
  const [temperature, setTemperature] = useState(0.2);
  const [maxIterations, setMaxIterations] = useState(15);
  const [codeTimeout, setCodeTimeout] = useState(30);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [desktopEnvs, setDesktopEnvs] = useState<DesktopEnvOption[]>([]);
  const [selectedDesktopEnv, setSelectedDesktopEnv] = useState("");
  const [desktopEnvStatus, setDesktopEnvStatus] = useState("");
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [integrationsError, setIntegrationsError] = useState("");
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});

  // General tab state
  const [preferences, setPreferences] = useState("");
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    fetch(`${baseUrl}/config`)
      .then((r) => r.json())
      .then((cfg) => {
        setAgentModel(cfg?.agent?.model ?? "");
        setTemperature(cfg?.agent?.temperature ?? 0.2);
        setMaxIterations(cfg?.agent?.max_iterations ?? 15);
        setCodeTimeout(cfg?.agent?.code_timeout ?? 30);
        setPreferences(cfg?.agent?.preferences ?? "");
        const provs = cfg?.llm?.providers ?? {};
        const list: ProviderState[] = Object.entries(provs).map(
          ([name, p]: [string, any]) => ({
            name,
            api_key: p.api_key ?? "",
            api_base: p.api_base ?? "",
            models: p.models ?? [],
          }),
        );
        setProviders(list.length ? list : [{ name: "", api_key: "", api_base: "", models: [] }]);
      })
      .catch(() => {});
  }, [baseUrl]);

  useEffect(() => {
    if (!window.scoutDesktop) return;
    let cancelled = false;
    (async () => {
      try {
        const [envs, current] = await Promise.all([
          window.scoutDesktop!.listPythonEnvs(),
          window.scoutDesktop!.getSelectedPythonEnv(),
        ]);
        if (cancelled) return;
        setDesktopEnvs(envs);
        if (current.pythonPath) {
          setSelectedDesktopEnv(`venv:${current.pythonPath}`);
          return;
        }
        if (current.condaEnv) {
          setSelectedDesktopEnv(`conda:${current.condaEnv}`);
          return;
        }
        setSelectedDesktopEnv("system:system");
      } catch {
        if (!cancelled) setDesktopEnvStatus("Could not load desktop Python environments.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setConfigValue = useCallback(
    async (key: string, value: any) => {
      await fetch(`${baseUrl}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, scope: "global" }),
      });
    },
    [baseUrl],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const provObj: Record<string, any> = {};
      for (const p of providers) {
        if (p.name.trim()) {
          provObj[p.name.trim()] = {
            api_key: p.api_key,
            ...(p.api_base ? { api_base: p.api_base } : {}),
            models: p.models.filter((m) => m.trim()),
          };
        }
      }
      await setConfigValue("llm.providers", provObj);
      await setConfigValue("agent.model", agentModel);
      await setConfigValue("agent.temperature", temperature);
      await setConfigValue("agent.max_iterations", maxIterations);
      await setConfigValue("agent.code_timeout", codeTimeout);
      await setConfigValue("agent.preferences", preferences);

      if (window.scoutDesktop && selectedDesktopEnv) {
        const split = selectedDesktopEnv.indexOf(":");
        const env = {
          type: selectedDesktopEnv.slice(0, split) as "venv" | "conda" | "system",
          value: selectedDesktopEnv.slice(split + 1),
        };
        const res = await window.scoutDesktop.selectPythonEnv(env);
        setDesktopEnvStatus(res.message);
      }

      await fetch(`${baseUrl}/config/reload`, { method: "POST" });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [baseUrl, providers, agentModel, temperature, maxIterations, codeTimeout, preferences, setConfigValue]);

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    if (!open || tab !== "memories") return;
    fetch(`${baseUrl}/memories/preferences`, { headers: authHeaders })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail ?? "Could not load memory preferences.");
        return r.json();
      })
      .then((d) => {
        setUseMemories(d.use_memories ?? true);
        setGenerateMemories(d.generate_memories ?? true);
        setMemoryPreferenceStatus("");
      })
      .catch((err) => setMemoryPreferenceStatus(err.message));
  }, [open, tab, baseUrl, token]);

  const updateMemoryPreferences = async (nextUse: boolean, nextGenerate: boolean) => {
    const previousUse = useMemories;
    const previousGenerate = generateMemories;
    setUseMemories(nextUse);
    setGenerateMemories(nextGenerate);
    setMemoryPreferenceStatus("Saving...");
    try {
      const r = await fetch(`${baseUrl}/memories/preferences`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          use_memories: nextUse,
          generate_memories: nextGenerate,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail ?? "Could not save memory preferences.");
      setMemoryPreferenceStatus(isMultiUser ? "Saved. Applies to new conversations." : "Saved.");
    } catch (err: any) {
      setUseMemories(previousUse);
      setGenerateMemories(previousGenerate);
      setMemoryPreferenceStatus(err.message ?? "Could not save memory preferences.");
    }
  };

  useEffect(() => {
    if (!open || tab !== "memories") return;
    setMemoriesLoading(true);
    fetch(`${baseUrl}/memories`, { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => {
        setMemoryEntries(d.entries ?? []);
      })
      .catch(() => {})
      .finally(() => setMemoriesLoading(false));
  }, [open, tab, baseUrl, token]);

  const handleAddMemory = async () => {
    if (!newMemory.trim()) return;
    const r = await fetch(`${baseUrl}/memories`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ entry: newMemory.trim() }),
    });
    const d = await r.json();
    setMemoryEntries(d.entries ?? []);
    setNewMemory("");
  };

  const handleRemoveMemory = async (index: number) => {
    const r = await fetch(`${baseUrl}/memories`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ remove_index: index }),
    });
    const d = await r.json();
    setMemoryEntries(d.entries ?? []);
  };

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (!open || tab !== "integrations" || !isMultiUser) return;
    fetch(`${baseUrl}/mcp/integrations`, { headers: authHeaders })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? "Could not load integrations."); return r.json(); })
      .then((d) => { setIntegrations(d.integrations ?? []); setIntegrationsError(""); })
      .catch((e) => setIntegrationsError(e.message));
  }, [open, tab, baseUrl, token, isMultiUser]);

  const toggleIntegration = async (integration: any) => {
    const enabled = !integration.user_enabled;
    const r = await fetch(`${baseUrl}/mcp/integrations/${integration.id}/enabled`, {
      method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
    });
    if (!r.ok) { setIntegrationsError((await r.json().catch(() => ({}))).detail ?? "Could not update integration."); return; }
    setIntegrations((items) => items.map((item) => item.id === integration.id ? { ...item, user_enabled: enabled } : item));
  };

  const saveIntegrationCredential = async (integration: any) => {
    const credential = credentialDrafts[integration.id]?.trim();
    if (!credential) return;
    const r = await fetch(`${baseUrl}/mcp/integrations/${integration.id}/credentials`, {
      method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ credential }),
    });
    if (!r.ok) { setIntegrationsError((await r.json().catch(() => ({}))).detail ?? "Could not save credential."); return; }
    setCredentialDrafts((items) => ({ ...items, [integration.id]: "" }));
    setIntegrations((items) => items.map((item) => item.id === integration.id ? { ...item, user_enabled: true, has_credential: true } : item));
  };

  const TABS: { id: Tab; label: string }[] = isMultiUser
    ? [
        { id: "general", label: "General" },
        { id: "integrations", label: "Integrations" },
        { id: "memories", label: "Memories" },
      ]
    : [
        { id: "general", label: "General" },
        { id: "models", label: "Models & Agent" },
        { id: "memories", label: "Memories" },
      ];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-scout-canvas flex flex-col">
      <div className="flex items-center gap-3 px-4 sm:px-6 h-[52px] shrink-0 border-b border-scout-hairline-faint bg-scout-canvas">
        <button
          onClick={onClose}
          className="p-2 rounded-btn hover:bg-scout-lift text-scout-muted hover:text-scout-text transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-[15px] font-semibold tracking-[-0.02em] text-scout-text">Settings</h1>
          <p className="text-[10px] text-scout-muted">Workspace and model preferences</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col md:flex-row overflow-hidden max-w-5xl mx-auto w-full px-3 sm:px-4 py-3 md:pb-6 gap-3 md:gap-4">
        <nav className="flex w-full shrink-0 gap-1 overflow-x-auto px-1 md:w-48 md:block md:space-y-1 md:overflow-visible md:px-2 md:py-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); onTabChange?.(t.id); }}
              className={`shrink-0 md:w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] font-medium transition-colors
                ${tab === t.id
                  ? "bg-scout-input-bg text-scout-text font-semibold ring-1 ring-scout-hairline"
                  : "font-medium text-scout-muted hover:bg-scout-input-bg hover:text-scout-text"
                }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto bg-scout-panel/80 rounded-hero border border-scout-hairline-faint py-6 px-5 sm:py-7 sm:px-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
          {tab === "general" && (
            <GeneralTab
              theme={theme}
              onSetTheme={setTheme}
              preferences={preferences}
              onSetPreferences={setPreferences}
            />
          )}
          {tab === "memories" && (
            <div className="space-y-6">
              <section className="max-w-2xl">
                <h2 className="text-[15px] font-semibold text-scout-text mb-1">Memories</h2>
                <p className="text-[13px] text-scout-muted mb-4">
                  MEMORY.md is the single memory file used by the agent.
                </p>
                <div className="flex flex-wrap gap-5 mb-5">
                  <label className="flex items-center gap-2 text-sm font-medium text-scout-text cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useMemories}
                      onChange={(e) => updateMemoryPreferences(e.target.checked, generateMemories)}
                      className="w-4 h-4 accent-scout-text"
                    />
                    Use memories
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium text-scout-text cursor-pointer">
                    <input
                      type="checkbox"
                      checked={generateMemories}
                      onChange={(e) => updateMemoryPreferences(useMemories, e.target.checked)}
                      className="w-4 h-4 accent-scout-text"
                    />
                    Generate memories
                  </label>
                </div>
                {memoryPreferenceStatus && (
                  <p className="text-xs font-medium text-scout-muted -mt-3 mb-5">
                    {memoryPreferenceStatus}
                  </p>
                )}
                <h3 className="text-sm font-semibold text-scout-text mb-1.5">MEMORY.md</h3>
                {memoriesLoading ? (
                  <p className="text-[13px] text-scout-muted">Loading…</p>
                ) : memoryEntries.length === 0 ? (
                  <div className="mb-3 flex items-center gap-3">
                    <PixelBook size={34} />
                    <p className="text-[13px] text-scout-muted">
                      No memories yet. Scout saves useful facts here as you chat, or add one below.
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-2 mb-4">
                    {memoryEntries.map((entry, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl border border-scout-hairline-faint bg-scout-canvas text-sm"
                      >
                        <span className="flex-1 text-scout-text">{entry.replace(/^- /, "")}</span>
                        <button
                          onClick={() => handleRemoveMemory(i)}
                          className="text-xs font-medium text-scout-muted hover:text-scout-error shrink-0"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <textarea
                  value={newMemory}
                  onChange={(e) => setNewMemory(e.target.value)}
                  placeholder="Add a memory (e.g. prefer matplotlib for charts)"
                  rows={2}
                  className="w-full bg-scout-input-bg border border-scout-hairline-faint rounded-2xl px-4 py-3
                             text-sm text-scout-text placeholder:text-scout-muted/60
                             outline-none focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20 resize-none"
                />
                <div className="mt-2">
                  <Button variant="filled" surface="panel" onClick={handleAddMemory} disabled={!newMemory.trim()}>
                    Add memory
                  </Button>
                </div>
              </section>
            </div>
          )}
          {tab === "integrations" && (
            <div className="space-y-5 max-w-2xl">
              <section>
                <h2 className="text-[15px] font-semibold text-scout-text mb-1">Integrations</h2>
                <p className="text-[13px] text-scout-muted">Enable tools your administrator has made available to your agent.</p>
              </section>
              {integrationsError && <p className="text-xs text-scout-error">{integrationsError}</p>}
              {integrations.length === 0 ? <p className="text-[13px] text-scout-muted py-6">No integrations are available yet.</p> : integrations.map((integration) => (
                <div key={integration.id} className="rounded-xl border border-scout-hairline-faint px-3.5 py-3 space-y-2">
                  <div className="flex items-center gap-3"><div className="flex-1 min-w-0"><p className="text-sm font-medium text-scout-text">{integration.name}</p><p className="text-[11px] text-scout-muted truncate">{integration.transport === "container_stdio" ? "isolated container" : "remote"} · {integration.tools?.length ?? 0} tools · {integration.health?.status ?? "not connected"}{integration.has_credential ? " · credential saved" : ""}</p></div>
                  <button onClick={() => toggleIntegration(integration)} className={`w-9 h-5 rounded-full transition-colors ${integration.user_enabled ? "bg-scout-success" : "bg-scout-hairline"}`} aria-label={`${integration.user_enabled ? "Disable" : "Enable"} ${integration.name}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${integration.user_enabled ? "translate-x-4" : "translate-x-0.5"}`} /></button></div>
                  {integration.transport !== "container_stdio" && <div className="flex gap-2"><input type="password" value={credentialDrafts[integration.id] ?? ""} onChange={(e) => setCredentialDrafts((items) => ({ ...items, [integration.id]: e.target.value }))} placeholder={integration.has_credential ? "Replace saved credential" : "API token (optional)"} className="flex-1 min-w-0 px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none" /><Button variant="outline" onClick={() => saveIntegrationCredential(integration)} disabled={!credentialDrafts[integration.id]?.trim()}>Save token</Button></div>}
                </div>
              ))}
            </div>
          )}
          {tab === "models" && (
            <ModelsTab
              providers={providers}
              setProviders={setProviders}
              agentModel={agentModel}
              setAgentModel={setAgentModel}
              temperature={temperature}
              setTemperature={setTemperature}
              maxIterations={maxIterations}
              setMaxIterations={setMaxIterations}
              codeTimeout={codeTimeout}
              setCodeTimeout={setCodeTimeout}
              showKeys={showKeys}
              setShowKeys={setShowKeys}
              desktopEnvs={desktopEnvs}
              selectedDesktopEnv={selectedDesktopEnv}
              setSelectedDesktopEnv={setSelectedDesktopEnv}
              desktopEnvStatus={desktopEnvStatus}
            />
          )}
        </div>
      </div>

      <div className="px-4 sm:px-6 py-3 flex justify-end max-w-5xl mx-auto w-full shrink-0 border-t border-scout-hairline-faint bg-scout-canvas/90">
        <div className="flex items-center gap-3">
          <Button variant="outlined" surface="canvas" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" surface="canvas" onClick={handleSave} disabled={saving}>
            {saved ? "Saved!" : saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── General tab ─────────────────────────────────────────────────── */

function GeneralTab({
  theme,
  onSetTheme,
  preferences,
  onSetPreferences,
}: {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  preferences: string;
  onSetPreferences: (v: string) => void;
}) {
  return (
    <div className="max-w-2xl divide-y divide-scout-hairline-faint [&>section]:py-8 [&>section:first-child]:pt-0 [&>section:last-child]:pb-0">
      {/* Preferences */}
      <section>
        <h2 className="text-[15px] font-semibold text-scout-text mb-1">Preferences</h2>
        <p className="text-[13px] text-scout-muted mb-3">
          What should Scout consider in responses? These apply to all conversations.
        </p>
        <textarea
          value={preferences}
          onChange={(e) => onSetPreferences(e.target.value)}
          placeholder="e.g. prefer concise answers, use metric units, focus on statistical rigor"
          rows={4}
          className="w-full bg-scout-input-bg border border-scout-hairline-faint rounded-2xl px-4 py-3
                     text-sm text-scout-text placeholder:text-scout-muted/60
                     outline-none focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20 resize-none"
        />
      </section>

      {/* Appearance */}
      <section>
        <h2 className="text-[15px] font-semibold text-scout-text mb-1">Appearance</h2>
        <p className="text-[13px] text-scout-muted mb-4">Color mode</p>
        <div className="flex gap-3">
          <ThemeCard
            icon={<Sun size={20} />}
            label="Light"
            active={theme === "light"}
            onClick={() => onSetTheme("light")}
            previewBg="#faf5ec"
            previewFg="#ffffff"
            previewAccent="#f4a261"
          />
          <ThemeCard
            icon={<Moon size={20} />}
            label="Dark"
            active={theme === "dark"}
            onClick={() => onSetTheme("dark")}
            previewBg="#0d0d0d"
            previewFg="#1a1a1a"
            previewAccent="#ffffff"
          />
          <ThemeCard
            icon={<Cloud size={20} />}
            label="Soft gray"
            active={theme === "soft"}
            onClick={() => onSetTheme("soft")}
            previewBg="#232426"
            previewFg="#2a2b2d"
            previewAccent="#c7c9cc"
          />
        </div>
      </section>

      {/* Keyboard shortcuts */}
      <section>
        <h2 className="text-[15px] font-semibold text-scout-text mb-4">Keyboard Shortcuts</h2>
        <div className="space-y-0 divide-y divide-scout-hairline-faint">
          {SHORTCUTS.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} desc={s.desc} />
          ))}
        </div>
      </section>

      {/* About */}
      <section>
        <h2 className="text-[15px] font-semibold text-scout-text mb-2">About</h2>
        <div className="space-y-1.5 text-[13px] font-medium text-scout-muted">
          <p><span className="text-scout-text font-semibold">Scout</span> {APP_VERSION}</p>
          <p>Configuration: <code className="text-xs bg-scout-input-bg border border-scout-hairline-faint px-1.5 py-0.5 rounded-md font-mono text-scout-text">~/.config/scout/config.yaml</code></p>
          <p>Project overrides: <code className="text-xs bg-scout-input-bg border border-scout-hairline-faint px-1.5 py-0.5 rounded-md font-mono text-scout-text">.scout/config.yaml</code></p>
        </div>
      </section>
    </div>
  );
}

/* ── Theme card (like Claude's Light/Auto/Dark cards) ────────────── */

function ThemeCard({
  icon,
  label,
  active,
  onClick,
  previewBg,
  previewFg,
  previewAccent,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  previewBg: string;
  previewFg: string;
  previewAccent: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 p-1 rounded-xl transition-all
        ${active
          ? "ring-2 ring-scout-text ring-offset-2 ring-offset-scout-bg"
          : "hover:opacity-80"
        }`}
    >
      {/* Mini preview */}
      <div
        className="w-28 h-[4.5rem] rounded-xl overflow-hidden border border-scout-hairline relative"
        style={{ backgroundColor: previewBg }}
      >
        {/* Fake sidebar */}
        <div
          className="absolute left-0 top-0 bottom-0 w-6"
          style={{ backgroundColor: previewFg, opacity: 0.5 }}
        />
        {/* Fake content lines */}
        <div className="absolute left-8 top-3 right-2 space-y-1.5">
          <div className="h-1.5 rounded-full w-3/4" style={{ backgroundColor: previewFg }} />
          <div className="h-1.5 rounded-full w-1/2" style={{ backgroundColor: previewFg }} />
        </div>
        {/* Fake input */}
        <div
          className="absolute bottom-2 left-8 right-2 h-3 rounded-full"
          style={{ backgroundColor: previewFg, opacity: 0.4 }}
        />
        {/* Accent dot */}
        <div
          className="absolute bottom-2.5 right-3 w-2 h-2 rounded-full"
          style={{ backgroundColor: previewAccent }}
        />
      </div>
      <span className={`text-xs ${active ? "text-scout-text font-semibold" : "text-scout-muted font-medium"}`}>
        {label}
      </span>
    </button>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px] font-medium text-scout-text/70">{desc}</span>
      <kbd className="px-2 py-1 rounded-lg bg-scout-input-bg border border-scout-hairline text-xs font-mono font-medium text-scout-text min-w-[40px] text-center shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]">
        {keys}
      </kbd>
    </div>
  );
}

/* ── Models & Agent tab ──────────────────────────────────────────── */

function ModelsTab({
  providers, setProviders,
  agentModel, setAgentModel,
  temperature, setTemperature,
  maxIterations, setMaxIterations,
  codeTimeout, setCodeTimeout,
  showKeys, setShowKeys,
  desktopEnvs,
  selectedDesktopEnv,
  setSelectedDesktopEnv,
  desktopEnvStatus,
}: {
  providers: ProviderState[];
  setProviders: (p: ProviderState[]) => void;
  agentModel: string;
  setAgentModel: (v: string) => void;
  temperature: number;
  setTemperature: (v: number) => void;
  maxIterations: number;
  setMaxIterations: (v: number) => void;
  codeTimeout: number;
  setCodeTimeout: (v: number) => void;
  showKeys: Record<string, boolean>;
  setShowKeys: (v: Record<string, boolean>) => void;
  desktopEnvs: DesktopEnvOption[];
  selectedDesktopEnv: string;
  setSelectedDesktopEnv: (v: string) => void;
  desktopEnvStatus: string;
}) {
  return (
    <div className="max-w-2xl divide-y divide-scout-hairline-faint [&>section]:py-8 [&>section:first-child]:pt-0 [&>section:last-child]:pb-0">
      {window.scoutDesktop && (
        <section>
          <h2 className="text-[15px] font-semibold text-scout-text mb-1">Python Runtime</h2>
          <p className="text-[13px] text-scout-muted mb-4">
            Select the Python environment used by `run_code` in this workspace.
          </p>
          <select
            value={selectedDesktopEnv}
            onChange={(e) => setSelectedDesktopEnv(e.target.value)}
            className="w-full max-w-xl bg-scout-input-bg border border-scout-hairline-faint rounded-xl px-3 py-2.5
                       text-sm font-medium text-scout-text outline-none focus:border-scout-text/30"
          >
            {desktopEnvs.map((env) => (
              <option key={`${env.type}:${env.value}`} value={`${env.type}:${env.value}`}>
                {env.label}
              </option>
            ))}
          </select>
          {desktopEnvStatus && (
            <p className="text-xs font-medium text-scout-muted mt-2">{desktopEnvStatus}</p>
          )}
        </section>
      )}

      {/* LLM Providers */}
      <section>
        <h2 className="text-[15px] font-semibold text-scout-text mb-1">LLM Providers</h2>
        <p className="text-[13px] text-scout-muted mb-4">
          Configure API keys and models for each provider.
        </p>

        <div className="space-y-4">
          {providers.map((prov, pi) => (
            <div
              key={pi}
              className="p-5 rounded-card border border-scout-hairline bg-scout-canvas space-y-4"
            >
              <FieldInput
                value={prov.name}
                onChange={(v) => {
                  const copy = [...providers];
                  copy[pi] = { ...copy[pi], name: v };
                  setProviders(copy);
                }}
                placeholder="groq, openai, anthropic..."
                label="Provider"
              />

              <div>
                <label className="text-caption font-medium text-scout-text block mb-1.5">API Key</label>
                <div className="flex items-center gap-2">
                  <input
                    type={showKeys[prov.name] ? "text" : "password"}
                    value={prov.api_key}
                    onChange={(e) => {
                      const copy = [...providers];
                      copy[pi] = { ...copy[pi], api_key: e.target.value };
                      setProviders(copy);
                    }}
                    placeholder="sk-..."
                    className="flex-1 bg-scout-input-bg border border-scout-hairline-faint rounded-xl px-3.5 py-2.5
                               text-sm text-scout-text outline-none focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20 font-mono
                               placeholder:text-scout-muted/60"
                  />
                  <button
                    onClick={() => setShowKeys({ ...showKeys, [prov.name]: !showKeys[prov.name] })}
                    className="p-2 rounded-btn text-scout-muted hover:text-scout-text
                               hover:bg-scout-lift transition-colors"
                  >
                    {showKeys[prov.name] ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <FieldInput
                value={prov.models.join(", ")}
                onChange={(v) => {
                  const copy = [...providers];
                  copy[pi] = { ...copy[pi], models: v.split(",").map((m) => m.trim()) };
                  setProviders(copy);
                }}
                placeholder="groq/llama-3.1-8b-instant, openai/gpt-4o"
                label="Models (comma separated)"
              />
            </div>
          ))}
        </div>

        <button
          onClick={() => setProviders([...providers, { name: "", api_key: "", api_base: "", models: [] }])}
          className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-scout-text/70 hover:text-scout-text transition-colors"
        >
          <Plus size={14} />
          Add provider
        </button>
      </section>

      {/* Agent Config */}
      <section>
        <h2 className="text-[15px] font-semibold text-scout-text mb-1">Agent Configuration</h2>
        <p className="text-[13px] text-scout-muted mb-4">
          Fine-tune how the agent behaves.
        </p>

        <div className="space-y-4">
          <FieldInput
            value={agentModel}
            onChange={setAgentModel}
            placeholder="groq/llama-3.1-8b-instant"
            label="Default Model"
          />

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-caption font-medium text-scout-text">Temperature</label>
              <span className="px-1.5 py-0.5 rounded-md bg-scout-input-bg border border-scout-hairline-faint font-mono text-xs font-medium text-scout-text">
                {temperature}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full accent-scout-text h-1.5"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FieldInput
              value={String(maxIterations)}
              onChange={(v) => setMaxIterations(parseInt(v) || 15)}
              label="Max Iterations"
              type="number"
            />
            <FieldInput
              value={String(codeTimeout)}
              onChange={(v) => setCodeTimeout(parseInt(v) || 30)}
              label="Code Timeout (s)"
              type="number"
            />
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── Reusable field input ────────────────────────────────────────── */

function FieldInput({
  value,
  onChange,
  placeholder,
  label,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-caption font-medium text-scout-text block mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-scout-input-bg border border-scout-hairline-faint rounded-xl px-3.5 py-2.5
                   text-sm text-scout-text outline-none focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20
                   placeholder:text-scout-muted/60"
      />
    </div>
  );
}
