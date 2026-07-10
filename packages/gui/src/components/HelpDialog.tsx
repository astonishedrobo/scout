import { Keyboard } from "lucide-react";
import { CenterModal } from "./ui/CenterModal";
import { APP_VERSION, SHORTCUTS } from "../appMeta";

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

const FEATURES = [
  { title: "Chat", desc: "Ask questions about your data. The agent can run Python code, search documents, and read files." },
  { title: "Tool Steps", desc: "Click the tool steps summary to expand and see what the agent did behind the scenes." },
  { title: "Approvals", desc: "Use the composer approval menu to ask every time, allow workspace edits, or grant full access. When Scout pauses, review proposed diffs in the composer before approving." },
  { title: "Settings", desc: "Configure LLM providers (API keys and models), agent parameters, and more." },
  { title: "Init Workspace", desc: "Generate .scout/skills/workspace.md to give the agent context about your project." },
];

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  return (
    <CenterModal open={open} onClose={onClose} title="Help" maxWidth="md">
      <div className="px-5 py-4 space-y-5">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Keyboard size={14} className="text-scout-muted" />
            <h4 className="text-sm font-semibold text-scout-text">Keyboard Shortcuts</h4>
          </div>
          <div className="space-y-2">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-scout-text/70">{s.desc}</span>
                <kbd className="px-2 py-1 rounded-lg bg-scout-input-bg border border-scout-hairline text-xs font-mono font-medium text-scout-text shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]">
                  {s.keys}
                </kbd>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4 className="text-sm font-semibold text-scout-text mb-3">Features</h4>
          <div className="space-y-3">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <p className="text-sm font-medium text-scout-text">{f.title}</p>
                <p className="text-[13px] text-scout-muted leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="text-xs font-medium text-scout-muted pt-3 border-t border-scout-hairline-faint">
          Scout {APP_VERSION}
        </p>
      </div>
    </CenterModal>
  );
}
