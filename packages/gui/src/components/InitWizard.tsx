import { useState, useCallback, useEffect } from "react";
import { Loader2, Check, RotateCcw, Pencil, Eye, Save } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CenterModal } from "./ui/CenterModal";
import { ConfirmDialog, type ConfirmRequest } from "./ui/ConfirmDialog";
import { Button } from "./ui/Button";
import { Select, Textarea } from "./ui/Input";

interface InitWizardProps {
  open: boolean;
  baseUrl: string;
  /** Bearer token. Required in multi-user, where these routes are protected —
   *  without it every call here 401s and the mount-time catch masks it. */
  token?: string | null;
  onClose: () => void;
}

type Step = "loading" | "env" | "generating" | "preview" | "editing" | "saving" | "done" | "error";

export function InitWizard({ open, baseUrl, token, onClose }: InitWizardProps) {
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  const isDesktopMode =
    typeof navigator !== "undefined" &&
    navigator.userAgent.toLowerCase().includes("electron");

  const [step, setStep] = useState<Step>("loading");
  const [applyingEnv, setApplyingEnv] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
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
        const resp = await fetch(`${baseUrl}/init-status`, { headers: authHeaders });
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
    await fetch(`${baseUrl}/config/reload`, { method: "POST", headers: authHeaders }).catch(() => {});
    return true;
  }, [selectedDesktopEnv, baseUrl, isDesktopMode]);

  /**
   * Regenerating replaces the skill from scratch, discarding any edits — it
   * used to do that silently.
   */
  const confirmRegenerate = () => {
    const edited = editContent.trim() && editContent.trim() !== content.trim();
    if (!edited) {
      void generate();
      return;
    }
    setConfirmRequest({
      title: "Regenerate the workspace skill?",
      body: "Your unsaved edits are discarded and the skill is written again from scratch.",
      confirmLabel: "Regenerate",
      onConfirm: () => generate(),
    });
  };

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
        headers: { "Content-Type": "application/json", ...authHeaders },
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
        headers: { "Content-Type": "application/json", ...authHeaders },
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
    <CenterModal
      open={open}
      onClose={onClose}
      title={skillExists && step !== "generating" ? "Workspace Skill" : "Initialize Workspace"}
      maxWidth="lg"
    >
        <div className="px-4 py-3.5">
          {isDesktopMode && (
            <div className="mb-3 rounded-btn border border-scout-hairline bg-scout-canvas/30 p-2.5">
              <p className="text-caption text-scout-muted mb-2">
                Python runtime for this workspace
              </p>
              <div className="flex items-center gap-2">
                <Select
                  size="md"
                  aria-label="Python runtime for this workspace"
                  value={selectedDesktopEnv}
                  onChange={(e) => setSelectedDesktopEnv(e.target.value)}
                  className="flex-1"
                >
                  {desktopEnvs.map((env) => (
                    <option key={`${env.type}:${env.value}`} value={`${env.type}:${env.value}`}>
                      {env.label}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outlined"
                  surface="panel"
                  onClick={async () => {
                    setApplyingEnv(true);
                    try {
                      await applyDesktopEnv();
                    } finally {
                      setApplyingEnv(false);
                    }
                  }}
                  loading={applyingEnv}
                  disabled={applyingEnv}
                >
                  Apply
                </Button>
              </div>
              <p className="text-micro text-scout-muted mt-2">
                The selected runtime is auto-applied before Generate/Save.
              </p>
              {desktopEnvStatus && (
                <p className="text-caption text-scout-muted mt-2">{desktopEnvStatus}</p>
              )}
            </div>
          )}

          {step === "env" && (
            <div className="flex flex-col items-center justify-center py-10">
              <p className="text-scout-text text-label font-medium mb-1">
                Select a Python environment first
              </p>
              <p className="text-scout-muted text-caption text-center max-w-md">
                This matches CLI behavior: choose runtime before generating workspace skills.
              </p>
            </div>
          )}

          {(step === "loading" || step === "generating") && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-scout-text mb-3" />
              <p className="text-scout-muted text-label">
                {step === "loading"
                  ? "Checking workspace..."
                  : "Analyzing project structure and generating workspace skills..."}
              </p>
            </div>
          )}

          {step === "saving" && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-scout-text mb-3" />
              <p className="text-scout-muted text-label">Saving...</p>
            </div>
          )}

          {step === "preview" && (
            <div className="prose-scout text-label">
              <p className="text-scout-muted text-caption mb-3">
                {skillExists ? (
                  <>Saved at <code>.scout/skills/workspace.md</code></>
                ) : (
                  <>Will be saved to <code>.scout/skills/workspace.md</code></>
                )}
              </p>
              <div className="rounded-btn border border-scout-hairline bg-scout-canvas/35 p-3">
                <MarkdownRenderer content={content} />
              </div>
            </div>
          )}

          {step === "editing" && (
            <div>
              <label htmlFor="init-skill-editor" className="mb-2 block text-caption text-scout-muted">
                Edit the workspace skill:
              </label>
              <Textarea
                id="init-skill-editor"
                size="md"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="h-80 font-mono"
              />
            </div>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center justify-center py-12">
              <Check size={32} className="text-scout-success mb-3" />
              <p className="text-scout-text font-medium">
                Workspace skill saved!
              </p>
              <p className="text-scout-muted text-label mt-1">
                Saved to <code>.scout/skills/workspace.md</code>
              </p>
            </div>
          )}

          {step === "error" && (
            <div className="text-center py-12">
              <p className="text-scout-error text-label mb-2">
                {error.includes("save") || error.includes("Save")
                  ? "Failed to save skill"
                  : "Failed to generate skill"}
              </p>
              <p className="text-scout-muted text-caption break-all">{error}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-1.5 border-t border-scout-hairline px-4 py-3">
          {step === "env" && (
            <>
              <Button variant="ghost" surface="panel" onClick={startInitWithSystem}>
                  Skip (System Python)
              </Button>
              <Button variant="filled" surface="panel" onClick={startInitWithCurrentEnv}>
                  Continue
              </Button>
            </>
          )}

          {step === "preview" && !skillExists && (
            <>
              <Button variant="ghost" surface="panel" onClick={confirmRegenerate}>
                  <RotateCcw size={14} /> Regenerate
              </Button>
              <Button variant="ghost" surface="panel" onClick={startEditing}>
                  <Pencil size={14} /> Edit
              </Button>
              <Button variant="filled" surface="panel" onClick={() => save(content)}>
                  <Check size={16} /> Approve & Save
              </Button>
            </>
          )}

          {step === "preview" && skillExists && (
            <>
              <Button variant="ghost" surface="panel" onClick={confirmRegenerate}>
                  <RotateCcw size={14} /> Regenerate
              </Button>
              <Button variant="filled" surface="panel" onClick={startEditing}>
                  <Pencil size={14} /> Edit
              </Button>
            </>
          )}

          {step === "editing" && (
            <>
              <Button variant="ghost" surface="panel" onClick={() => {
                  setEditContent(content);
                  setStep("preview");
                }}>
                  <Eye size={14} /> Preview
              </Button>
              <Button variant="filled" surface="panel" onClick={() => save(editContent)}>
                  <Save size={16} /> Save
              </Button>
            </>
          )}

          {step === "done" && (
            <div className="flex gap-2">
              <Button variant="ghost" surface="panel" onClick={startEditing}>
                  <Pencil size={14} /> Edit
              </Button>
              <Button variant="filled" surface="panel" onClick={onClose}>
                  Close
              </Button>
            </div>
          )}

          {step === "error" && (
            <div className="flex gap-2">
              <Button variant="ghost" surface="panel" onClick={generate}>
                  <RotateCcw size={14} /> Retry
              </Button>
              <Button variant="filled" surface="panel" onClick={onClose}>
                  Close
              </Button>
            </div>
          )}
        </div>
      <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
    </CenterModal>
  );
}
