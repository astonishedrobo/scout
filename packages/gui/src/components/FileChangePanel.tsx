import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, GitCompareArrows, X } from "lucide-react";
import type { FileChangeEntry, FileChangeSet } from "scout-core";
import { DiffViewer } from "./DiffViewer";
import { PanelExpandButton } from "./ui/PanelExpandButton";

function reverseUnifiedDiff(diff: string) {
  return diff
    .split("\n")
    .map((line) => {
      const hunk = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/);
      if (hunk) return `@@ -${hunk[2]} +${hunk[1]} @@${hunk[3]}`;
      if (line.startsWith("+++ ")) return `--- ${line.slice(4)}`;
      if (line.startsWith("--- ")) return `+++ ${line.slice(4)}`;
      if (line.startsWith("+")) return `-${line.slice(1)}`;
      if (line.startsWith("-")) return `+${line.slice(1)}`;
      return line;
    })
    .join("\n");
}

function statusLabel(entry: FileChangeEntry, undone: boolean) {
  if (!undone) {
    if (entry.status === "added") return "Added";
    if (entry.status === "deleted") return "Deleted";
    return "Modified";
  }
  if (entry.status === "added") return "Removed";
  if (entry.status === "deleted") return "Restored";
  return "Reverted";
}

function diffStats(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function FileChangePanel({
  changeSet,
  onClose,
  expanded = false,
  onToggleExpand,
}: {
  changeSet: FileChangeSet;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const undone = !!changeSet.undone;
  const [activePath, setActivePath] = useState(changeSet.entries[0]?.path ?? "");

  useEffect(() => {
    setActivePath((current) => (
      changeSet.entries.some((entry) => entry.path === current)
        ? current
        : changeSet.entries[0]?.path ?? ""
    ));
  }, [changeSet.id, changeSet.entries]);

  const activeEntry = changeSet.entries.find((entry) => entry.path === activePath) ?? changeSet.entries[0];
  const stats = useMemo(
    () => changeSet.entries.reduce(
      (total, entry) => {
        const entryStats = diffStats(entry.diff);
        return {
          additions: total.additions + entryStats.additions,
          deletions: total.deletions + entryStats.deletions,
        };
      },
      { additions: 0, deletions: 0 },
    ),
    [changeSet.entries],
  );

  return (
    <div className="flex h-full flex-col bg-scout-canvas">
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-scout-hairline-faint px-3.5">
        {undone ? <CheckCircle2 size={16} className="shrink-0 text-scout-success" /> : <GitCompareArrows size={16} className="shrink-0 text-scout-muted" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-scout-text">{undone ? "Undo applied" : "Review"}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-scout-muted">
            <span>{undone ? "Workspace restored" : "Last turn"}</span>
            <span className="font-medium text-scout-success">+{stats.additions}</span>
            <span className="font-medium text-scout-error">−{stats.deletions}</span>
          </div>
        </div>
        {onToggleExpand && <PanelExpandButton expanded={expanded} onToggle={onToggleExpand} />}
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-scout-muted hover:bg-scout-lift hover:text-scout-text"
          aria-label="Close review"
        >
          <X size={17} />
        </button>
      </div>
      {changeSet.entries.length > 1 && (
        <div className="flex shrink-0 overflow-x-auto border-b border-scout-hairline-faint px-2 py-1.5">
          {changeSet.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              onClick={() => setActivePath(entry.path)}
              className={`max-w-[14rem] truncate rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${
                entry.path === activeEntry?.path
                  ? "bg-scout-lift text-scout-text"
                  : "text-scout-muted hover:bg-scout-lift/60 hover:text-scout-text"
              }`}
            >
              {entry.path}
            </button>
          ))}
        </div>
      )}
      {activeEntry && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-scout-code-bg/75">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-scout-hairline-faint bg-scout-panel/45 px-3.5">
            <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${undone ? "text-scout-success" : "text-scout-muted"}`}>
              {statusLabel(activeEntry, undone)}
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-scout-text">{activeEntry.path}</span>
          </div>
          <DiffViewer
            diff={undone ? reverseUnifiedDiff(activeEntry.diff) : activeEntry.diff}
            maxHeight="none"
            className="flex-1 bg-transparent"
          />
        </div>
      )}
    </div>
  );
}
