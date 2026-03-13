import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Eye, EyeOff, Check, Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type Theme } from "../hooks/useTheme";

interface SettingsPanelProps {
  baseUrl: string;
  isMultiUser?: boolean;
  onClose: () => void;
}

type Tab = "general" | "models";

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

export function SettingsPanel({ baseUrl, isMultiUser, onClose }: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>("general");
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

  const TABS: { id: Tab; label: string }[] = isMultiUser
    ? [{ id: "general", label: "General" }]
    : [
        { id: "general", label: "General" },
        { id: "models", label: "Models & Agent" },
      ];

  return (
    <div className="fixed inset-0 z-50 bg-scout-bg flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 h-14 border-b border-scout-border flex-shrink-0">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-scout-surface-hover text-scout-text-secondary transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-semibold text-scout-text-primary">Settings</h1>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden max-w-4xl mx-auto w-full">
        {/* Tab nav */}
        <nav className="w-48 flex-shrink-0 py-6 px-4 space-y-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors
                ${tab === t.id
                  ? "bg-scout-accent/15 text-scout-accent font-medium"
                  : "text-scout-text-secondary hover:bg-scout-surface-hover hover:text-scout-text-primary"
                }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto py-6 pr-6 pl-2">
          {tab === "general" && (
            <GeneralTab
              theme={theme}
              onSetTheme={setTheme}
              preferences={preferences}
              onSetPreferences={setPreferences}
            />
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

      {/* Footer */}
      <div className="border-t border-scout-border px-6 py-3 flex justify-end max-w-4xl mx-auto w-full flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-scout-text-secondary
                       border border-scout-border hover:bg-scout-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 rounded-lg text-sm font-medium
                       bg-scout-surface-hover text-scout-text-primary border border-scout-border
                       hover:bg-scout-border transition-colors
                       disabled:opacity-60"
          >
            {saved ? "Saved!" : saving ? "Saving..." : "Save changes"}
          </button>
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
    <div className="space-y-8">
      {/* Preferences */}
      <section>
        <h2 className="text-base font-semibold text-scout-text-primary mb-1">Preferences</h2>
        <p className="text-sm text-scout-text-secondary mb-3">
          What should Scout consider in responses? These apply to all conversations.
        </p>
        <textarea
          value={preferences}
          onChange={(e) => onSetPreferences(e.target.value)}
          placeholder="e.g. prefer concise answers, use metric units, focus on statistical rigor"
          rows={4}
          className="w-full bg-scout-surface border border-scout-border rounded-xl px-4 py-3
                     text-sm text-scout-text-primary placeholder:text-scout-text-secondary/50
                     outline-none focus:border-scout-accent resize-none"
        />
      </section>

      {/* Appearance */}
      <section>
        <h2 className="text-base font-semibold text-scout-text-primary mb-1">Appearance</h2>
        <p className="text-sm text-scout-text-secondary mb-4">Color mode</p>
        <div className="flex gap-3">
          <ThemeCard
            icon={<Sun size={20} />}
            label="Light"
            active={theme === "light"}
            onClick={() => onSetTheme("light")}
            previewBg="#ffffff"
            previewFg="#e0e0e0"
            previewAccent="#f87171"
          />
          <ThemeCard
            icon={<Moon size={20} />}
            label="Dark"
            active={theme === "dark"}
            onClick={() => onSetTheme("dark")}
            previewBg="#2f2f2f"
            previewFg="#4a4a4a"
            previewAccent="#f87171"
          />
        </div>
      </section>

      {/* Keyboard shortcuts */}
      <section>
        <h2 className="text-base font-semibold text-scout-text-primary mb-4">Keyboard Shortcuts</h2>
        <div className="space-y-0 divide-y divide-scout-border">
          <ShortcutRow keys="Enter" desc="Send message" />
          <ShortcutRow keys="Shift+Enter" desc="New line" />
          <ShortcutRow keys="/" desc="Open commands menu" />
          <ShortcutRow keys="@" desc="Reference a file" />
          <ShortcutRow keys="Esc" desc="Dismiss dropdowns" />
        </div>
      </section>

      {/* About */}
      <section>
        <h2 className="text-base font-semibold text-scout-text-primary mb-1">About</h2>
        <div className="space-y-1.5 text-sm text-scout-text-secondary">
          <p><span className="text-scout-text-primary font-medium">Scout</span> v0.1.0</p>
          <p>Configuration: <code className="text-xs bg-scout-surface px-1.5 py-0.5 rounded font-mono">~/.config/scout/config.yaml</code></p>
          <p>Project overrides: <code className="text-xs bg-scout-surface px-1.5 py-0.5 rounded font-mono">.scout/config.yaml</code></p>
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
          ? "ring-2 ring-scout-accent ring-offset-2 ring-offset-scout-bg"
          : "hover:opacity-80"
        }`}
    >
      {/* Mini preview */}
      <div
        className="w-24 h-16 rounded-lg overflow-hidden border border-scout-border relative"
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
      <span className={`text-xs ${active ? "text-scout-text-primary font-medium" : "text-scout-text-secondary"}`}>
        {label}
      </span>
    </button>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-scout-text-secondary">{desc}</span>
      <kbd className="px-2 py-1 rounded-md bg-scout-surface border border-scout-border text-xs font-mono text-scout-text-primary min-w-[40px] text-center">
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
    <div className="space-y-8">
      {window.scoutDesktop && (
        <section>
          <h2 className="text-base font-semibold text-scout-text-primary mb-1">Python Runtime</h2>
          <p className="text-sm text-scout-text-secondary mb-4">
            Select the Python environment used by `run_code` in this workspace.
          </p>
          <select
            value={selectedDesktopEnv}
            onChange={(e) => setSelectedDesktopEnv(e.target.value)}
            className="w-full max-w-xl bg-scout-bg border border-scout-border rounded-lg px-3 py-2
                       text-sm text-scout-text-primary outline-none focus:border-scout-accent"
          >
            {desktopEnvs.map((env) => (
              <option key={`${env.type}:${env.value}`} value={`${env.type}:${env.value}`}>
                {env.label}
              </option>
            ))}
          </select>
          {desktopEnvStatus && (
            <p className="text-xs text-scout-text-secondary mt-2">{desktopEnvStatus}</p>
          )}
        </section>
      )}

      {/* LLM Providers */}
      <section>
        <h2 className="text-base font-semibold text-scout-text-primary mb-1">LLM Providers</h2>
        <p className="text-sm text-scout-text-secondary mb-4">
          Configure API keys and models for each provider.
        </p>

        <div className="space-y-4">
          {providers.map((prov, pi) => (
            <div
              key={pi}
              className="p-4 rounded-xl border border-scout-border bg-scout-surface space-y-3"
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
                <label className="text-xs text-scout-text-secondary block mb-1.5">API Key</label>
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
                    className="flex-1 bg-scout-bg border border-scout-border rounded-lg px-3 py-2
                               text-sm text-scout-text-primary outline-none focus:border-scout-accent font-mono
                               placeholder:text-scout-text-secondary/40"
                  />
                  <button
                    onClick={() => setShowKeys({ ...showKeys, [prov.name]: !showKeys[prov.name] })}
                    className="p-2 rounded-lg text-scout-text-secondary hover:text-scout-text-primary
                               hover:bg-scout-surface-hover transition-colors"
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
          className="mt-3 text-sm text-scout-text-secondary hover:text-scout-text-primary transition-colors"
        >
          + Add provider
        </button>
      </section>

      {/* Separator */}
      <div className="border-t border-scout-border" />

      {/* Agent Config */}
      <section>
        <h2 className="text-base font-semibold text-scout-text-primary mb-1">Agent Configuration</h2>
        <p className="text-sm text-scout-text-secondary mb-4">
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
              <label className="text-xs text-scout-text-secondary">Temperature</label>
              <span className="text-xs text-scout-text-secondary font-mono">{temperature}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full accent-scout-accent h-1.5"
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
      <label className="text-xs text-scout-text-secondary block mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-scout-bg border border-scout-border rounded-lg px-3 py-2
                   text-sm text-scout-text-primary outline-none focus:border-scout-accent
                   placeholder:text-scout-text-secondary/40"
      />
    </div>
  );
}
