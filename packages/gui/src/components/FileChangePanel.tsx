import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, GitCompareArrows } from "lucide-react";
import type { FileChangeEntry, FileChangeSet } from "scout-core";
import { DiffViewer } from "./DiffViewer";
import { PanelBreadcrumb } from "./ui/PanelBreadcrumb";
import { EmptyState } from "./ui/EmptyState";
import { PathLabel } from "./PathLabel";

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

export function FileChangePanel({ changeSet }: { changeSet: FileChangeSet }) {
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
      <PanelBreadcrumb
        crumbs={[
          { label: undone ? "Undo applied" : "Review" },
          { label: undone ? "Workspace restored" : "Last turn" },
        ]}
        meta={
          <span className="flex items-center gap-1.5">
            {undone && <CheckCircle2 size={12} className="text-scout-success" />}
            <span className="font-medium text-scout-success">+{stats.additions}</span>
            <span className="font-medium text-scout-error">-{stats.deletions}</span>
          </span>
        }
      />
      {changeSet.entries.length > 1 && (
        <div className="flex shrink-0 overflow-x-auto border-b border-scout-hairline-faint px-2 py-1.5">
          {changeSet.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              onClick={() => setActivePath(entry.path)}
              title={entry.path}
              className={`max-w-[14rem] shrink-0 rounded-btn px-2.5 py-1.5 font-mono text-micro transition-colors ${
                entry.path === activeEntry?.path
                  ? "bg-scout-lift text-scout-text"
                  : "text-scout-muted hover:bg-scout-lift/60 hover:text-scout-text"
              }`}
            >
              <PathLabel path={entry.path} />
            </button>
          ))}
        </div>
      )}
      {/* An empty change set is reachable (a turn that touched nothing), and
          used to render the "+0 −0" header above a blank pane. */}
      {!activeEntry && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={<GitCompareArrows size={20} />}
            body={
              undone
                ? "Nothing left to review — the workspace was restored."
                : "No file changes in the last turn."
            }
          />
        </div>
      )}
      {activeEntry && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-scout-code-bg/75">
          <div className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-scout-hairline-faint bg-scout-panel/95 px-3.5 backdrop-blur-sm">
            <span className={`text-micro font-semibold uppercase tracking-[0.08em] ${undone ? "text-scout-success" : "text-scout-muted"}`}>
              {statusLabel(activeEntry, undone)}
            </span>
            <PathLabel path={activeEntry.path} className="min-w-0 font-mono text-caption text-scout-text" />
          </div>
          <DiffViewer
            showFilenames={false}
            diff={undone ? reverseUnifiedDiff(activeEntry.diff) : activeEntry.diff}
            maxHeight="none"
            className="flex-1 bg-transparent"
          />
        </div>
      )}
    </div>
  );
}
