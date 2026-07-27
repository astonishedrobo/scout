import { Keyboard } from "lucide-react";
import { CenterModal } from "./ui/CenterModal";
import { ShortcutRow } from "./ui/ShortcutRow";
import { APP_VERSION } from "../appMeta";
import { SHORTCUTS, shortcutKeys } from "../shortcuts";

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
            <h4 className="text-label font-semibold text-scout-text">Keyboard Shortcuts</h4>
          </div>
          <div className="divide-y divide-scout-hairline-faint">
            {SHORTCUTS.map((s) => (
              <ShortcutRow key={s.id} keys={shortcutKeys(s)} desc={s.desc} />
            ))}
          </div>
        </section>

        <section>
          <h4 className="text-label font-semibold text-scout-text mb-3">Features</h4>
          <div className="space-y-3">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <p className="text-label font-medium text-scout-text">{f.title}</p>
                <p className="text-label text-scout-muted leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="text-caption font-medium text-scout-muted pt-3 border-t border-scout-hairline-faint">
          Scout {APP_VERSION}
        </p>
      </div>
    </CenterModal>
  );
}
