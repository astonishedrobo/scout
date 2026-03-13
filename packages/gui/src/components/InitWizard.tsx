import { useState, useCallback, useEffect } from "react";
import { X, Loader2, Check, RotateCcw, Pencil, Eye, Save } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface InitWizardProps {
  baseUrl: string;
  onClose: () => void;
}

type Step = "loading" | "env" | "generating" | "preview" | "editing" | "saving" | "done" | "error";

export function InitWizard({ baseUrl, onClose }: InitWizardProps) {
  const isDesktopMode =
    typeof navigator !== "undefined" &&
    navigator.userAgent.toLowerCase().includes("electron");

  const [step, setStep] = useState<Step>("loading");
  const [content, setContent] = useState("");
  const [editContent, setEditContent] = useState("");
  const [error, setError] = useState("");
  const [skillExists, setSkillExists] = useState(false);
  const [desktopEnvs, setDesktopEnvs] = useState<
    Array<{ label: string; value: string; type: "venv" | "conda" | "system" }>
  >([]);
  const [selectedDesktopEnv, setSelectedDesktopEnv] = useState("");
  const [desktopEnvStatus, setDesktopEnvStatus] = useState("");

  const parseSelectedEnv = useCallback(
    (value: string): { type: "venv" | "conda" | "system"; name: string } | null => {
      if (!value) return null;
      const idx = value.indexOf(":");
      if (idx <= 0) return null;
      return {
        type: value.slice(0, idx) as "venv" | "conda" | "system",
        name: value.slice(idx + 1),
      };
    },
    [],
  );

  const withPythonEnvSection = useCallback(
    (raw: string, selected: string): string => {
      const env = parseSelectedEnv(selected);
      if (!env || env.type === "system") return raw;

      const cleaned = raw.replace(
        /\n## Python Environment[\s\S]*?(?=\n## |\n# |\s*$)/g,
        "",
      ).trimEnd();

      return (
        `${cleaned}\n\n## Python Environment\n\n` +
        `- **Type:** ${env.type}\n` +
        `- **Name:** ${env.name}\n` +
        `- **Note:** User prefers this environment for code execution. Use packages available here.\n`
      );
    },
    [parseSelectedEnv],
  );

  // Check if skill already exists on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${baseUrl}/init-status`);
        if (!resp.ok) throw new Error("Failed to check status");
        const data = await resp.json();
        if (cancelled) return;
        if (data.exists && data.content) {
          setContent(data.content);
          setEditContent(data.content);
          setSkillExists(true);
          if (isDesktopMode) {
            setStep("env");
          } else {
            setStep("preview");
          }
        } else {
          // No existing skill:
          // - desktop app: match CLI flow and ask env first
          // - web mode: generate immediately
          if (isDesktopMode) {
            setStep("env");
          } else {
            generate();
          }
        }
      } catch {
        if (!cancelled) {
          if (isDesktopMode) setStep("env");
          else generate();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, isDesktopMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isDesktopMode) return;
    let cancelled = false;
    (async () => {
      if (!window.scoutDesktop) {
        if (cancelled) return;
        setDesktopEnvs([{ label: "System Python", value: "system", type: "system" }]);
        setSelectedDesktopEnv("system:system");
        setDesktopEnvStatus("Desktop runtime bridge unavailable; only system fallback is available.");
        return;
      }
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
        if (!cancelled) setDesktopEnvStatus("Could not load Python environments.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDesktopMode]);

  const applyDesktopEnv = useCallback(async (showStatus = true, envOverride?: string): Promise<boolean> => {
    if (!isDesktopMode) return true;
    const selected = envOverride ?? selectedDesktopEnv;
    if (!selected) return true;
    if (!window.scoutDesktop) {
      if (showStatus) {
        setDesktopEnvStatus(
          "Desktop bridge unavailable. Cannot apply a specific venv/conda env in this session.",
        );
      }
      return selected === "system:system";
    }
    const split = selected.indexOf(":");
    const env = {
      type: selected.slice(0, split) as "venv" | "conda" | "system",
      value: selected.slice(split + 1),
    };
    const res = await window.scoutDesktop.selectPythonEnv(env);
    if (showStatus) setDesktopEnvStatus(res.message);
    if (!res.ok) return false;
    await fetch(`${baseUrl}/config/reload`, { method: "POST" }).catch(() => {});
    return true;
  }, [selectedDesktopEnv, baseUrl, isDesktopMode]);

  const generate = useCallback(async () => {
    setStep("generating");
    setError("");
    try {
      const envOk = await applyDesktopEnv(false);
      if (!envOk) {
        throw new Error("Could not apply selected Python environment.");
      }
      const resp = await fetch(`${baseUrl}/init-skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory_summary: "" }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "Unknown error");
        throw new Error(text);
      }
      const body = await resp.json();
      const generated = body.content ?? "";
      const enriched = withPythonEnvSection(generated, selectedDesktopEnv);
      setContent(enriched);
      setEditContent(enriched);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }, [baseUrl, applyDesktopEnv, selectedDesktopEnv, withPythonEnvSection]);

  const startInitWithCurrentEnv = useCallback(async () => {
    const envOk = await applyDesktopEnv(true);
    if (!envOk) {
      setStep("error");
      setError("Could not apply selected Python environment.");
      return;
    }
    if (skillExists) {
      const enriched = withPythonEnvSection(content, selectedDesktopEnv);
      setContent(enriched);
      setEditContent(enriched);
      setStep("preview");
      return;
    }
    await generate();
  }, [applyDesktopEnv, skillExists, generate, content, selectedDesktopEnv, withPythonEnvSection]);

  const startInitWithSystem = useCallback(async () => {
    const systemValue = "system:system";
    setSelectedDesktopEnv(systemValue);
    await applyDesktopEnv(true, systemValue);
    if (skillExists) {
      const enriched = withPythonEnvSection(content, systemValue);
      setContent(enriched);
      setEditContent(enriched);
      setStep("preview");
      return;
    }
    await generate();
  }, [applyDesktopEnv, skillExists, generate, content, withPythonEnvSection]);

  const save = useCallback(async (text: string) => {
    setStep("saving");
    try {
      const envOk = await applyDesktopEnv(false);
      if (!envOk) {
        throw new Error("Could not apply selected Python environment.");
      }
      const finalContent = withPythonEnvSection(text, selectedDesktopEnv);
      const resp = await fetch(`${baseUrl}/init-save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: finalContent }),
      });
      if (!resp.ok) {
        const msg = await resp.text().catch(() => "Save failed");
        throw new Error(msg);
      }
      setContent(finalContent);
      setEditContent(finalContent);
      setSkillExists(true);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }, [baseUrl, applyDesktopEnv, selectedDesktopEnv, withPythonEnvSection]);

  const startEditing = useCallback(() => {
    setEditContent(content);
    setStep("editing");
  }, [content]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-scout-surface border border-scout-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-scout-border">
          <h3 className="font-semibold text-scout-text-primary">
            {skillExists && step !== "generating" ? "Workspace Skill" : "Initialize Workspace"}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-scout-surface-hover text-scout-text-secondary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isDesktopMode && (
            <div className="mb-4 p-3 rounded-lg border border-scout-border bg-scout-bg/40">
              <p className="text-xs text-scout-text-secondary mb-2">
                Python runtime for this workspace
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={selectedDesktopEnv}
                  onChange={(e) => setSelectedDesktopEnv(e.target.value)}
                  className="flex-1 bg-scout-bg border border-scout-border rounded-lg px-3 py-2
                             text-sm text-scout-text-primary outline-none focus:border-scout-accent"
                >
                  {desktopEnvs.map((env) => (
                    <option key={`${env.type}:${env.value}`} value={`${env.type}:${env.value}`}>
                      {env.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => applyDesktopEnv()}
                  className="px-3 py-2 rounded-lg text-sm bg-scout-surface-hover text-scout-text-primary
                             hover:bg-scout-border transition-colors"
                >
                  Apply
                </button>
              </div>
              <p className="text-[11px] text-scout-text-secondary mt-2">
                The selected runtime is auto-applied before Generate/Save.
              </p>
              {desktopEnvStatus && (
                <p className="text-xs text-scout-text-secondary mt-2">{desktopEnvStatus}</p>
              )}
            </div>
          )}

          {step === "env" && (
            <div className="flex flex-col items-center justify-center py-10">
              <p className="text-scout-text-primary text-sm font-medium mb-1">
                Select a Python environment first
              </p>
              <p className="text-scout-text-secondary text-xs text-center max-w-md">
                This matches CLI behavior: choose runtime before generating workspace skills.
              </p>
            </div>
          )}

          {(step === "loading" || step === "generating") && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-scout-accent mb-3" />
              <p className="text-scout-text-secondary text-sm">
                {step === "loading"
                  ? "Checking workspace..."
                  : "Analyzing project structure and generating workspace skills..."}
              </p>
            </div>
          )}

          {step === "saving" && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-scout-accent mb-3" />
              <p className="text-scout-text-secondary text-sm">Saving...</p>
            </div>
          )}

          {step === "preview" && (
            <div className="prose-scout text-sm">
              <p className="text-scout-text-secondary text-xs mb-3">
                {skillExists ? (
                  <>Saved at <code>.scout/skills/workspace.md</code></>
                ) : (
                  <>Will be saved to <code>.scout/skills/workspace.md</code></>
                )}
              </p>
              <div className="border border-scout-border rounded-lg p-4 bg-scout-bg/50">
                <MarkdownRenderer content={content} />
              </div>
            </div>
          )}

          {step === "editing" && (
            <div>
              <p className="text-scout-text-secondary text-xs mb-2">
                Edit the workspace skill:
              </p>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-80 bg-scout-bg border border-scout-border rounded-lg p-3
                           text-sm text-scout-text-primary font-mono outline-none
                           focus:border-scout-accent resize-none"
              />
            </div>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center justify-center py-12">
              <Check size={32} className="text-scout-success mb-3" />
              <p className="text-scout-text-primary font-medium">
                Workspace skill saved!
              </p>
              <p className="text-scout-text-secondary text-sm mt-1">
                Saved to <code>.scout/skills/workspace.md</code>
              </p>
            </div>
          )}

          {step === "error" && (
            <div className="text-center py-12">
              <p className="text-scout-error text-sm mb-2">
                {error.includes("save") || error.includes("Save")
                  ? "Failed to save skill"
                  : "Failed to generate skill"}
              </p>
              <p className="text-scout-text-secondary text-xs break-all">{error}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t border-scout-border flex gap-2 justify-end">
          {step === "env" && (
            <>
              <button
                onClick={startInitWithSystem}
                className="px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                Skip (System Python)
              </button>
              <button
                onClick={startInitWithCurrentEnv}
                className="px-4 py-2 rounded-lg text-sm font-medium
                           bg-scout-accent text-white hover:bg-scout-accent-hover transition-colors"
              >
                Continue
              </button>
            </>
          )}

          {step === "preview" && !skillExists && (
            <>
              <button
                onClick={generate}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                <RotateCcw size={14} /> Regenerate
              </button>
              <button
                onClick={startEditing}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                <Pencil size={14} /> Edit
              </button>
              <button
                onClick={() => save(content)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium
                           bg-scout-accent text-white hover:bg-scout-accent-hover transition-colors"
              >
                <Check size={16} /> Approve & Save
              </button>
            </>
          )}

          {step === "preview" && skillExists && (
            <>
              <button
                onClick={generate}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                <RotateCcw size={14} /> Regenerate
              </button>
              <button
                onClick={startEditing}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium
                           bg-scout-accent text-white hover:bg-scout-accent-hover transition-colors"
              >
                <Pencil size={14} /> Edit
              </button>
            </>
          )}

          {step === "editing" && (
            <>
              <button
                onClick={() => {
                  setEditContent(content);
                  setStep("preview");
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                <Eye size={14} /> Preview
              </button>
              <button
                onClick={() => save(editContent)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium
                           bg-scout-accent text-white hover:bg-scout-accent-hover transition-colors"
              >
                <Save size={16} /> Save
              </button>
            </>
          )}

          {step === "done" && (
            <div className="flex gap-2">
              <button
                onClick={startEditing}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                <Pencil size={14} /> Edit
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium
                           bg-scout-accent text-white hover:bg-scout-accent-hover transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {step === "error" && (
            <div className="flex gap-2">
              <button
                onClick={generate}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                           text-scout-text-secondary hover:bg-scout-surface-hover transition-colors"
              >
                <RotateCcw size={14} /> Retry
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium
                           bg-scout-accent text-white hover:bg-scout-accent-hover transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
