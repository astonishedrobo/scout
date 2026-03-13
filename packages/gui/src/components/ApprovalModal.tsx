import { useState } from "react";
import { X, Check, CheckCheck, XCircle, MessageSquare } from "lucide-react";
import type { ApprovalRequest } from "../hooks/useChat";

interface ApprovalModalProps {
  request: ApprovalRequest;
  onRespond: (action: string, feedback?: string) => void;
}

function DiffLine({ line }: { line: string }) {
  let cls = "text-scout-text-secondary";
  if (line.startsWith("+")) cls = "text-scout-success";
  else if (line.startsWith("-")) cls = "text-scout-error";
  else if (line.startsWith("@@")) cls = "text-scout-cyan";

  return (
    <div className={`${cls} font-mono text-xs whitespace-pre`}>{line}</div>
  );
}

export function ApprovalModal({ request, onRespond }: ApprovalModalProps) {
  const [suggestMode, setSuggestMode] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-scout-surface border border-scout-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-scout-border">
          <h3 className="font-semibold text-scout-text-primary">
            File Changes
          </h3>
          <button
            onClick={() => onRespond("no")}
            className="p-1 rounded-lg hover:bg-scout-surface-hover text-scout-text-secondary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Diffs */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {request.diffs.map((entry, i) => {
            const statusColor =
              entry.status === "added"
                ? "text-scout-success"
                : entry.status === "deleted"
                  ? "text-scout-error"
                  : "text-scout-warning";
            const statusLabel =
              entry.status === "added"
                ? "NEW"
                : entry.status === "deleted"
                  ? "DELETE"
                  : "MODIFIED";

            const lines = entry.diff.split("\n").filter(
              (l) =>
                !l.startsWith("diff --git") &&
                !l.startsWith("index ") &&
                !l.startsWith("---") &&
                !l.startsWith("+++") &&
                !l.startsWith("new file") &&
                !l.startsWith("deleted file"),
            );

            return (
              <div key={i}>
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded ${statusColor} bg-current/10`}
                  >
                    {statusLabel}
                  </span>
                  <span className="text-sm text-scout-accent font-mono">
                    {entry.path}
                  </span>
                </div>
                <div className="bg-scout-bg rounded-lg border border-scout-border p-3 overflow-x-auto max-h-48 overflow-y-auto">
                  {lines.slice(0, 30).map((line, j) => (
                    <DiffLine key={j} line={line} />
                  ))}
                  {lines.length > 30 && (
                    <div className="text-xs text-scout-text-secondary italic mt-1">
                      ... {lines.length - 30} more lines
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t border-scout-border">
          {!suggestMode ? (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onRespond("yes")}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-scout-success/20
                           text-scout-success hover:bg-scout-success/30 text-sm font-medium transition-colors"
              >
                <Check size={16} /> Approve
              </button>
              <button
                onClick={() => onRespond("always")}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-scout-accent/20
                           text-scout-accent hover:bg-scout-accent/30 text-sm font-medium transition-colors"
              >
                <CheckCheck size={16} /> Always Approve
              </button>
              <button
                onClick={() => setSuggestMode(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-scout-surface-hover
                           text-scout-text-secondary hover:text-scout-text-primary text-sm font-medium transition-colors"
              >
                <MessageSquare size={16} /> Suggest Changes
              </button>
              <button
                onClick={() => onRespond("no")}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-scout-error/20
                           text-scout-error hover:bg-scout-error/30 text-sm font-medium transition-colors ml-auto"
              >
                <XCircle size={16} /> Reject
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-scout-accent">
                Describe the changes you'd like:
              </p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  type="text"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && feedback.trim()) {
                      onRespond("suggest", feedback.trim());
                    }
                    if (e.key === "Escape") setSuggestMode(false);
                  }}
                  placeholder="Type your suggestion..."
                  className="flex-1 bg-scout-bg border border-scout-border rounded-lg px-3 py-2
                             text-sm text-scout-text-primary outline-none focus:border-scout-accent"
                />
                <button
                  onClick={() => {
                    if (feedback.trim())
                      onRespond("suggest", feedback.trim());
                  }}
                  disabled={!feedback.trim()}
                  className="px-4 py-2 rounded-lg bg-scout-accent text-scout-bg text-sm font-medium
                             disabled:opacity-40 hover:bg-scout-accent/80 transition-colors"
                >
                  Send
                </button>
                <button
                  onClick={() => setSuggestMode(false)}
                  className="px-3 py-2 rounded-lg text-sm text-scout-text-secondary
                             hover:bg-scout-surface-hover transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
