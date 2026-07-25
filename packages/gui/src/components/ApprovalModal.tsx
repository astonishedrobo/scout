import { useState } from "react";
import { Check, CheckCheck, XCircle, MessageSquare, Share2, Shield } from "lucide-react";
import type { ApprovalRequest } from "../hooks/useChat";
import { CenterModal } from "./ui/CenterModal";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { DiffViewer } from "./DiffViewer";
import { Badge } from "./ui/Badge";

interface ApprovalModalProps {
  request: ApprovalRequest;
  onRespond: (action: string, feedback?: string, saveExecpolicy?: boolean) => void;
}

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
            <span className="text-micro font-semibold uppercase tracking-wider text-scout-muted">Reason</span>
            <p className="text-label text-scout-text">{pr.reason}</p>
          </div>
          {pr.network_domains && pr.network_domains.length > 0 && (
            <div>
              <span className="text-micro font-semibold uppercase tracking-wider text-scout-muted">Network domains</span>
              <p className="text-label font-mono text-scout-muted">{pr.network_domains.join(", ")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-scout-hairline-faint">
            <Button
              onClick={() => onRespond("allow_once")}
              tone="success" variant="filled" surface="panel"
            >
              <Check size={16} /> Allow Once
            </Button>
            <Button
              onClick={() => onRespond("allow_session")}
              variant="filledInverse" surface="panel"
            >
              <CheckCheck size={16} /> Allow for Session
            </Button>
            <Button
              onClick={() => onRespond("deny")}
              tone="danger" variant="filled" surface="panel" className="ml-auto"
            >
              <XCircle size={16} /> Deny
            </Button>
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
            <span className="text-micro font-semibold uppercase tracking-wider text-scout-muted">Capability</span>
            <p className="text-label font-mono text-scout-text">{cap.capability}</p>
          </div>
          <div>
            <span className="text-micro font-semibold uppercase tracking-wider text-scout-muted">Reason</span>
            <p className="text-label text-scout-text">{cap.reason}</p>
          </div>
          {cap.command_summary && (
            <div>
              <span className="text-micro font-semibold uppercase tracking-wider text-scout-muted">Command</span>
              <p className="text-label font-mono text-scout-muted">{cap.command_summary}</p>
            </div>
          )}
          {Object.keys(cap.scope).length > 0 && (
            <div>
              <span className="text-micro font-semibold uppercase tracking-wider text-scout-muted">Scope</span>
              <pre className="text-caption font-mono bg-scout-code-bg rounded-card p-2 mt-1 overflow-x-auto border border-scout-hairline-faint">
                {JSON.stringify(cap.scope, null, 2)}
              </pre>
            </div>
          )}
          <p className="text-caption text-scout-muted">
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
              <span className="text-caption text-scout-muted">Save to execpolicy (always allow this prefix)</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-scout-hairline-faint">
            <Button
              onClick={() => onRespond("allow_once")}
              tone="success" variant="filled" surface="panel"
            >
              <Check size={16} /> Allow Once
            </Button>
            <Button
              onClick={() => onRespond("allow_session", undefined, saveExecpolicy)}
              variant="filledInverse" surface="panel"
            >
              <CheckCheck size={16} /> Allow for Session
            </Button>
            <Button
              onClick={() => onRespond("deny")}
              tone="danger" variant="filled" surface="panel" className="ml-auto"
            >
              <XCircle size={16} /> Deny
            </Button>
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
        <p className="px-5 pt-4 text-label text-scout-muted">
          Promote staged execution output to your workspace? Files below were created in an isolated staging area.
        </p>
      )}

      <div className="space-y-4 px-5 py-4">
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
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-scout-hairline-faint bg-scout-panel/95 px-3 py-2.5 backdrop-blur-sm">
                <Badge uppercase className={`border border-scout-hairline-faint ${statusColor}`}>
                  {statusLabel}
                </Badge>
                <span className="min-w-0 truncate text-caption text-scout-text font-mono">{entry.path}</span>
              </div>
              <DiffViewer diff={entry.diff} maxHeight="14rem" showFilenames={false} />
            </section>
          );
        })}
      </div>

      <div className="px-5 py-4 border-t border-scout-hairline-faint">
        {!suggestMode ? (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => onRespond("yes")}
              tone="success" variant="filled" surface="panel"
            >
              <Check size={16} /> {isPromotion ? "Promote" : "Approve"}
            </Button>
            {!isPromotion && (
              <Button
                onClick={() => onRespond("always")}
                variant="filledInverse" surface="panel"
              >
                <CheckCheck size={16} /> Always Approve
              </Button>
            )}
            {request.canShare && !isPromotion && (
              <Button
                onClick={() => onRespond("shared")}
                tone="info" variant="filled" surface="panel"
                title="Move into the shared team repo"
              >
                <Share2 size={16} /> Approve &amp; Save to Shared
              </Button>
            )}
            <Button
              onClick={() => setSuggestMode(true)}
              variant="filledInverse" surface="panel"
            >
              <MessageSquare size={16} /> Suggest Changes
            </Button>
            <Button
              onClick={() => onRespond("no")}
              tone="danger" variant="filled" surface="panel" className="ml-auto"
            >
              <XCircle size={16} /> Reject
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-label text-scout-text">Describe the changes you&apos;d like:</p>
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
