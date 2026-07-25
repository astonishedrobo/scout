import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronRight,
  FilePenLine,
  Loader2,
  MessageSquare,
  Network,
  Share2,
  Terminal,
  X,
} from "lucide-react";
import type { FileDiffEntry } from "scout-core";
import type { ApprovalRequest } from "../hooks/useChat";
import { DiffViewer } from "./DiffViewer";
import { Button } from "./ui/Button";

interface ApprovalDockProps {
  request: ApprovalRequest;
  baseUrl: string;
  sessionId: string;
  token: string | null;
  onRespond: (action: string, feedback?: string, saveExecpolicy?: boolean) => Promise<void>;
}

function statsFor(diffs: FileDiffEntry[]) {
  let additions = 0;
  let deletions = 0;
  for (const entry of diffs) {
    for (const line of entry.diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function statusLabel(status: FileDiffEntry["status"]) {
  if (status === "added") return "New";
  if (status === "deleted") return "Deleted";
  return "Modified";
}

function statusTone(status: FileDiffEntry["status"]) {
  if (status === "added") return "text-scout-success";
  if (status === "deleted") return "text-scout-error";
  return "text-scout-warning";
}

export function ApprovalDock({ request, baseUrl, sessionId, token, onRespond }: ApprovalDockProps) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [diffs, setDiffs] = useState<FileDiffEntry[]>(request.diffs);
  const [activePath, setActivePath] = useState(request.diffs[0]?.path ?? "");
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveExecpolicy, setSaveExecpolicy] = useState(false);

  useEffect(() => {
    setReviewOpen(false);
    setDiffs(request.diffs);
    setActivePath(request.diffs[0]?.path ?? "");
    setSuggesting(false);
    setFeedback("");
    setSubmitting(null);
    setError(null);
  }, [request.approvalId, request.diffs]);

  const respond = async (action: string, suggestion?: string, savePolicy?: boolean) => {
    if (submitting) return;
    setSubmitting(action);
    setError(null);
    try {
      await onRespond(action, suggestion, savePolicy);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send approval response");
      setSubmitting(null);
    }
  };

  const openReview = async () => {
    const next = !reviewOpen;
    setReviewOpen(next);
    if (!next || loadingDiffs || !diffs.some((entry) => entry.truncated)) return;
    setLoadingDiffs(true);
    setError(null);
    try {
      const response = await fetch(
        `${baseUrl}/sessions/${sessionId}/approvals/${request.approvalId}/diffs`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!response.ok) throw new Error("Could not load the complete proposed changes");
      const body = await response.json() as { diffs?: FileDiffEntry[] };
      if (body.diffs?.length) setDiffs(body.diffs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load proposed changes");
    } finally {
      setLoadingDiffs(false);
    }
  };

  const stats = useMemo(() => statsFor(diffs), [diffs]);
  const activeDiff = diffs.find((entry) => entry.path === activePath) ?? diffs[0];
  const isPromotion = request.kind === "execution_promotion";
  const isFiles = request.kind === "file_changes" || isPromotion;

  if (!isFiles) {
    const isPermission = request.kind === "permission_elevation";
    const cap = request.capability;
    const permission = request.permissionRequest;
    const actor = request.subagentDescription || "Scout";
    const title = isPermission
      ? `${actor} wants network access`
      : `${actor} needs permission to continue`;
    const detail = isPermission ? permission?.reason : cap?.reason;
    const command = cap?.command_summary;

    return (
      <div className="overflow-hidden rounded-hero border border-scout-hairline bg-scout-panel shadow-composer">
        <div className="px-4 pb-3 pt-4 sm:px-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-scout-warning-muted text-scout-warning">
              {isPermission ? <Network size={16} /> : <Terminal size={16} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-label font-semibold text-scout-text">{title}</div>
              {detail && <p className="mt-1 text-caption leading-relaxed text-scout-muted">{detail}</p>}
              {permission?.network_domains?.length ? (
                <div className="mt-2 rounded-card bg-scout-code-bg px-3 py-2 font-mono text-caption text-scout-text/85">
                  {permission.network_domains.join(", ")}
                </div>
              ) : null}
              {command && (
                <div className="mt-2 max-h-28 overflow-auto rounded-card bg-scout-code-bg px-3 py-2 font-mono text-caption text-scout-text/85">
                  {command}
                </div>
              )}
              {cap && Object.keys(cap.scope).length > 0 && (
                <details className="mt-2 text-caption text-scout-muted">
                  <summary className="cursor-pointer select-none">View requested scope</summary>
                  <pre className="mt-1 max-h-28 overflow-auto rounded-card bg-scout-code-bg p-2 font-mono text-micro">
                    {JSON.stringify(cap.scope, null, 2)}
                  </pre>
                </details>
              )}
              {command && (
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-caption text-scout-muted">
                  <input
                    type="checkbox"
                    checked={saveExecpolicy}
                    onChange={(event) => setSaveExecpolicy(event.target.checked)}
                    className="accent-scout-text"
                  />
                  Always allow this command prefix
                </label>
              )}
            </div>
          </div>
        </div>
        {error && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-card bg-scout-error-muted px-3 py-2 text-caption text-scout-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-scout-hairline-faint px-3 py-3 sm:px-4">
          <Button
            variant="ghost"
            surface="panel"
            size="compact"
            disabled={!!submitting}
            loading={submitting === "deny"}
            onClick={() => void respond("deny")}
          >
            Deny
          </Button>
          <Button
            variant="ghost"
            surface="panel"
            size="compact"
            className="ml-auto !text-scout-text"
            disabled={!!submitting}
            loading={submitting === "allow_session"}
            onClick={() => void respond("allow_session", undefined, saveExecpolicy)}
          >
            Allow for session
          </Button>
          <Button
            variant="filled"
            surface="panel"
            size="compact"
            disabled={!!submitting}
            loading={submitting === "allow_once"}
            onClick={() => void respond("allow_once")}
          >
            <Check size={14} />
            Allow once
          </Button>
        </div>
      </div>
    );
  }

  const actor = request.subagentDescription || "Scout";
  const title = isPromotion
    ? `${actor} wants to promote ${diffs.length} staged file${diffs.length === 1 ? "" : "s"}`
    : `${actor} wants to edit ${diffs.length} file${diffs.length === 1 ? "" : "s"}`;

  return (
    <div className="overflow-hidden rounded-hero border border-scout-hairline bg-scout-panel shadow-composer">
      <div className="px-4 pb-3 pt-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-scout-warning-muted text-scout-warning">
            <FilePenLine size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-label font-semibold text-scout-text">{title}</h2>
              <span className="text-caption font-medium text-scout-success">+{stats.additions}</span>
              <span className="text-caption font-medium text-scout-error">−{stats.deletions}</span>
            </div>
            <p className="mt-0.5 text-caption text-scout-muted">
              {isPromotion ? "Review staged execution output before it enters your workspace." : "Review the proposed changes before Scout writes them."}
            </p>
            <div className="mt-2 space-y-1">
              {diffs.slice(0, 3).map((entry) => (
                <div key={entry.path} className="flex min-w-0 items-center gap-2 text-caption">
                  <span className={`w-14 shrink-0 font-semibold ${statusTone(entry.status)}`}>{statusLabel(entry.status)}</span>
                  <span className="truncate font-mono text-scout-text/80">{entry.path}</span>
                </div>
              ))}
              {diffs.length > 3 && <div className="text-caption text-scout-muted">+{diffs.length - 3} more files</div>}
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void openReview()}
        className="flex w-full items-center gap-2 border-y border-scout-hairline-faint px-4 py-2.5 text-left text-caption font-semibold text-scout-muted transition-colors hover:bg-scout-lift/60 hover:text-scout-text sm:px-5"
      >
        <ChevronRight size={14} className={`transition-transform ${reviewOpen ? "rotate-90" : ""}`} />
        Review changes
        {diffs.some((entry) => entry.truncated) && <span className="font-normal text-scout-warning">Complete diff loads on review</span>}
        {loadingDiffs && <Loader2 size={13} className="ml-auto animate-spin" />}
      </button>

      {reviewOpen && activeDiff && (
        <div className="border-b border-scout-hairline-faint bg-scout-code-bg/50">
          {diffs.length > 1 && (
            <div className="flex gap-1 overflow-x-auto border-b border-scout-hairline-faint bg-scout-panel/60 px-2 py-1.5">
              {diffs.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  onClick={() => setActivePath(entry.path)}
                  className={`max-w-52 shrink-0 truncate rounded-btn px-2.5 py-1.5 font-mono text-micro transition-colors ${entry.path === activeDiff.path ? "bg-scout-lift text-scout-text" : "text-scout-muted hover:bg-scout-lift/60"}`}
                >
                  {entry.path}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 border-b border-scout-hairline-faint px-3 py-2">
            <span className={`text-micro font-semibold uppercase tracking-wider ${statusTone(activeDiff.status)}`}>{statusLabel(activeDiff.status)}</span>
            <span className="min-w-0 truncate font-mono text-caption text-scout-text">{activeDiff.path}</span>
          </div>
          <DiffViewer diff={activeDiff.diff} maxHeight="min(38vh, 22rem)" />
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-card bg-scout-error-muted px-3 py-2 text-caption text-scout-error">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {suggesting ? (
        <div className="p-3 sm:p-4">
          <div className="flex items-end gap-2 rounded-card border border-scout-hairline-faint bg-scout-input-bg/70 p-2">
            <textarea
              autoFocus
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSuggesting(false);
                if (event.key === "Enter" && !event.shiftKey && feedback.trim()) {
                  event.preventDefault();
                  void respond("suggest", feedback.trim());
                }
              }}
              placeholder="Describe what Scout should change…"
              rows={2}
              className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-label text-scout-text outline-none placeholder:text-scout-muted"
            />
            <button type="button" onClick={() => setSuggesting(false)} className="rounded-full p-2 text-scout-muted transition-colors hover:bg-scout-lift" aria-label="Cancel suggestion"><X size={16} /></button>
            <button
              type="button"
              disabled={!feedback.trim() || !!submitting}
              onClick={() => void respond("suggest", feedback.trim())}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-scout-text text-scout-bg disabled:opacity-35"
              aria-label="Send suggestion"
            >
              {submitting === "suggest" ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-3 sm:px-4">
          <Button
            variant="ghost"
            surface="panel"
            size="compact"
            disabled={!!submitting}
            loading={submitting === "no"}
            onClick={() => void respond("no")}
          >
            Reject
          </Button>
          {!isPromotion && (
            <Button variant="ghost" surface="panel" size="compact" disabled={!!submitting} onClick={() => setSuggesting(true)}>
              <MessageSquare size={13} /> Suggest changes
            </Button>
          )}
          {request.canShare && !isPromotion && (
            <Button
              tone="info"
              size="compact"
              disabled={!!submitting}
              loading={submitting === "shared"}
              onClick={() => void respond("shared")}
            >
              <Share2 size={13} /> Approve &amp; share
            </Button>
          )}
          <Button
            variant="filled"
            surface="panel"
            size="compact"
            className="ml-auto"
            disabled={!!submitting}
            loading={submitting === "yes"}
            onClick={() => void respond("yes")}
          >
            {isPromotion ? <CheckCheck size={14} /> : <Check size={14} />}
            {isPromotion ? "Promote" : "Approve once"}
          </Button>
        </div>
      )}
    </div>
  );
}
