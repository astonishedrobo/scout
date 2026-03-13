import { X, Keyboard } from "lucide-react";

interface HelpDialogProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: "Enter", desc: "Send message" },
  { keys: "Shift + Enter", desc: "New line in input" },
  { keys: "@file", desc: "Attach a file for analysis" },
];

const FEATURES = [
  { title: "Chat", desc: "Ask questions about your data. The agent can run Python code, search documents, and read files." },
  { title: "Tool Steps", desc: "Click the tool steps summary to expand and see what the agent did behind the scenes." },
  { title: "File Approvals", desc: "When the agent writes files, you'll see a diff and can approve, reject, or suggest changes." },
  { title: "Settings", desc: "Configure LLM providers (API keys and models), agent parameters, and more." },
  { title: "Init Workspace", desc: "Generate .scout/skills/workspace.md to give the agent context about your project." },
];

export function HelpDialog({ onClose }: HelpDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-scout-surface border border-scout-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-scout-border">
          <h3 className="font-semibold text-scout-text-primary">Help</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-scout-surface-hover text-scout-text-secondary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Shortcuts */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <Keyboard size={14} className="text-scout-text-secondary" />
              <h4 className="text-sm font-semibold text-scout-text-primary">
                Keyboard Shortcuts
              </h4>
            </div>
            <div className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center justify-between text-sm">
                  <span className="text-scout-text-secondary">{s.desc}</span>
                  <kbd className="px-2 py-0.5 rounded bg-scout-bg border border-scout-border text-xs font-mono text-scout-text-primary">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </section>

          {/* Features */}
          <section>
            <h4 className="text-sm font-semibold text-scout-text-primary mb-2">
              Features
            </h4>
            <div className="space-y-3">
              {FEATURES.map((f) => (
                <div key={f.title}>
                  <p className="text-sm font-medium text-scout-text-primary">{f.title}</p>
                  <p className="text-xs text-scout-text-secondary leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Version */}
          <p className="text-xs text-scout-text-secondary pt-2 border-t border-scout-border">
            Scout v0.1.0
          </p>
        </div>
      </div>
    </div>
  );
}
