import { useState } from "react";
import { Check, CheckCheck, XCircle, MessageSquare, Share2, Shield } from "lucide-react";
import type { ApprovalRequest } from "../hooks/useChat";
import { CenterModal } from "./ui/CenterModal";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { DiffViewer } from "./DiffViewer";

interface ApprovalModalProps {
  request: ApprovalRequest;
  onRespond: (action: string, feedback?: string, saveExecpolicy?: boolean) => void;
}

const actionBtn =
  "flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-transparent transition-all";

export function ApprovalModal({ request, onRespond }: ApprovalModalProps) {
  const [suggestMode, setSuggestMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [saveExecpolicy, setSaveExecpolicy] = useState(false);

  if (request.kind === "permission_elevation" && request.permissionRequest) {
    const pr = request.permissionRequest;
    return (
      <CenterModal
        open
        onClose={() => onRespond("deny")}
        title="Permission Elevation"
        maxWidth="md"
        closeOnEscape={false}
        closeOnBackdrop={false}
      >
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 text-scout-warning mb-2">
            <Shield size={18} />
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-scout-muted">Reason</span>
            <p className="text-sm text-scout-text">{pr.reason}</p>
          </div>
          {pr.network_domains && pr.network_domains.length > 0 && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-scout-muted">Network domains</span>
              <p className="text-sm font-mono text-scout-muted">{pr.network_domains.join(", ")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-scout-hairline-faint">
            <button
              onClick={() => onRespond("allow_once")}
              className={`${actionBtn} bg-scout-success-muted text-scout-success border-scout-success/15 hover:border-scout-success/30`}
            >
              <Check size={16} /> Allow Once
            </button>
            <button
              onClick={() => onRespond("allow_session")}
              className={`${actionBtn} bg-scout-lift/80 text-scout-text border-scout-hairline-faint hover:bg-scout-lift`}
            >
              <CheckCheck size={16} /> Allow for Session
            </button>
            <button
              onClick={() => onRespond("deny")}
              className={`${actionBtn} bg-scout-error-muted text-scout-error border-scout-error/15 hover:border-scout-error/30 ml-auto`}
            >
              <XCircle size={16} /> Deny
            </button>
          </div>
        </div>
      </CenterModal>
    );
  }

  if (request.kind === "capability" && request.capability) {
    const cap = request.capability;
    return (
      <CenterModal
        open
        onClose={() => onRespond("deny")}
        title="Capability Request"
        maxWidth="md"
        closeOnEscape={false}
        closeOnBackdrop={false}
      >
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 text-scout-warning mb-2">
            <Shield size={18} />
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-scout-muted">Capability</span>
            <p className="text-sm font-mono text-scout-text">{cap.capability}</p>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-scout-muted">Reason</span>
            <p className="text-sm text-scout-text">{cap.reason}</p>
          </div>
          {cap.command_summary && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-scout-muted">Command</span>
              <p className="text-sm font-mono text-scout-muted">{cap.command_summary}</p>
            </div>
          )}
          {Object.keys(cap.scope).length > 0 && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-scout-muted">Scope</span>
              <pre className="text-xs font-mono bg-scout-code-bg rounded-xl p-2 mt-1 overflow-x-auto border border-scout-hairline-faint">
                {JSON.stringify(cap.scope, null, 2)}
              </pre>
            </div>
          )}
          <p className="text-xs text-scout-muted">
            Approving grants this capability only — execution remains sandboxed.
          </p>
          {cap.command_summary && (
            <label className="flex items-center gap-2 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={saveExecpolicy}
                onChange={(e) => setSaveExecpolicy(e.target.checked)}
                className="accent-scout-text w-3.5 h-3.5"
              />
              <span className="text-xs text-scout-muted">Save to execpolicy (always allow this prefix)</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-scout-hairline-faint">
            <button
              onClick={() => onRespond("allow_once")}
              className={`${actionBtn} bg-scout-success-muted text-scout-success border-scout-success/15 hover:border-scout-success/30`}
            >
              <Check size={16} /> Allow Once
            </button>
            <button
              onClick={() => onRespond("allow_session", undefined, saveExecpolicy)}
              className={`${actionBtn} bg-scout-lift/80 text-scout-text border-scout-hairline-faint hover:bg-scout-lift`}
            >
              <CheckCheck size={16} /> Allow for Session
            </button>
            <button
              onClick={() => onRespond("deny")}
              className={`${actionBtn} bg-scout-error-muted text-scout-error border-scout-error/15 hover:border-scout-error/30 ml-auto`}
            >
              <XCircle size={16} /> Deny
            </button>
          </div>
        </div>
      </CenterModal>
    );
  }

  const isPromotion = request.kind === "execution_promotion";

  return (
    <CenterModal
      open
      onClose={() => onRespond("no")}
      title={isPromotion ? "Promote Staged Output" : "File Changes"}
      maxWidth="lg"
      closeOnEscape={false}
      closeOnBackdrop={false}
    >
      {isPromotion && (
        <p className="px-5 pt-4 text-sm text-scout-muted">
          Promote staged execution output to your workspace? Files below were created in an isolated staging area.
        </p>
      )}

      <div className="px-5 py-4 space-y-4 max-h-[50vh] overflow-y-auto">
        {request.diffs.map((entry, i) => {
          const statusColor =
            entry.status === "added"
              ? "text-scout-success"
              : entry.status === "deleted"
                ? "text-scout-error"
                : "text-scout-warning";
          const statusLabel =
            entry.status === "added" ? "NEW" : entry.status === "deleted" ? "DELETE" : "MODIFIED";

          return (
            <section key={i} className="overflow-hidden rounded-card border border-scout-hairline-faint bg-scout-panel/60">
              <div className="flex items-center gap-2 border-b border-scout-hairline-faint bg-scout-panel/75 px-3 py-2.5">
                <span className={`text-[11px] font-semibold tracking-wide px-2 py-0.5 rounded-lg border border-scout-hairline-faint ${statusColor}`}>
                  {statusLabel}
                </span>
                <span className="min-w-0 truncate text-xs text-scout-text font-mono">{entry.path}</span>
              </div>
              <DiffViewer diff={entry.diff} maxHeight="14rem" />
            </section>
          );
        })}
      </div>

      <div className="px-5 py-4 border-t border-scout-hairline-faint">
        {!suggestMode ? (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => onRespond("yes")}
              className={`${actionBtn} bg-scout-success-muted text-scout-success border-scout-success/15 hover:border-scout-success/30`}
            >
              <Check size={16} /> {isPromotion ? "Promote" : "Approve"}
            </button>
            {!isPromotion && (
              <button
                onClick={() => onRespond("always")}
                className={`${actionBtn} bg-scout-lift/80 text-scout-text border-scout-hairline-faint hover:bg-scout-lift`}
              >
                <CheckCheck size={16} /> Always Approve
              </button>
            )}
            {request.canShare && !isPromotion && (
              <button
                onClick={() => onRespond("shared")}
                className={`${actionBtn} bg-scout-lift/80 text-scout-cyan border-scout-hairline-faint hover:bg-scout-lift`}
                title="Move into the shared team repo"
              >
                <Share2 size={16} /> Approve &amp; Save to Shared
              </button>
            )}
            <button
              onClick={() => setSuggestMode(true)}
              className={`${actionBtn} text-scout-muted hover:text-scout-text hover:bg-scout-lift/80`}
            >
              <MessageSquare size={16} /> Suggest Changes
            </button>
            <button
              onClick={() => onRespond("no")}
              className={`${actionBtn} bg-scout-error-muted text-scout-error border-scout-error/15 hover:border-scout-error/30 ml-auto`}
            >
              <XCircle size={16} /> Reject
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-scout-text">Describe the changes you&apos;d like:</p>
            <div className="flex gap-2">
              <Input
                autoFocus
                type="text"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && feedback.trim()) onRespond("suggest", feedback.trim());
                  if (e.key === "Escape") setSuggestMode(false);
                }}
                placeholder="Type your suggestion..."
                className="flex-1"
              />
              <Button
                variant="filled"
                surface="panel"
                onClick={() => feedback.trim() && onRespond("suggest", feedback.trim())}
                disabled={!feedback.trim()}
              >
                Send
              </Button>
              <Button variant="ghost" surface="panel" onClick={() => setSuggestMode(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </CenterModal>
  );
}
