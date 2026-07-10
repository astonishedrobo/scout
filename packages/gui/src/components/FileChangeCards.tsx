import { Check, FilePenLine, RotateCcw, GitCompareArrows } from "lucide-react";
import type { FileChangeSet } from "scout-core";

function statusTone(status: string) {
  if (status === "added") return "text-scout-success";
  if (status === "deleted") return "text-scout-error";
  return "text-scout-warning";
}

export function FileChangeCards({
  changeSets,
  onReview,
  onUndo,
}: {
  changeSets: FileChangeSet[];
  onReview: (changeSet: FileChangeSet) => void;
  onUndo: (changeSet: FileChangeSet) => void;
}) {
  const visible = changeSets.filter((set) => set.entries.length > 0);
  if (!visible.length) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {visible.map((changeSet) => {
        const count = changeSet.entries.length;
        const reversible = changeSet.entries.every((entry) => entry.reversible);
        return (
          <div
            key={changeSet.id}
            className="flex w-full max-w-[45rem] items-center gap-3 rounded-card border border-scout-hairline-faint bg-scout-card-peach px-3.5 py-3"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-[#f0a058]/15 text-[#f0a058]">
              <FilePenLine size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-scout-text">
                {changeSet.undone ? "Undo applied" : `Edited ${count} file${count === 1 ? "" : "s"}`}
              </span>
              <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-scout-muted">
                {changeSet.entries.slice(0, 3).map((entry) => (
                  <span key={entry.path} className="min-w-0 truncate">
                    <span className={statusTone(entry.status)}>●</span> {entry.path}
                  </span>
                ))}
                {changeSet.entries.length > 3 && <span>+{changeSet.entries.length - 3} more</span>}
                {changeSet.undone && <span className="font-medium text-scout-success">Workspace restored</span>}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => onReview(changeSet)}
                className="inline-flex items-center gap-1.5 rounded-btn border border-scout-hairline-faint bg-scout-input-bg/80 px-3 py-2 text-xs font-semibold text-scout-text hover:bg-scout-lift"
              >
                <GitCompareArrows size={13} />
                Review
              </button>
              <button
                type="button"
                disabled={!reversible || !!changeSet.undone}
                onClick={() => onUndo(changeSet)}
                className="inline-flex items-center gap-1.5 rounded-btn border border-scout-hairline-faint bg-scout-input-bg/80 px-3 py-2 text-xs font-semibold text-scout-text hover:bg-scout-lift disabled:cursor-not-allowed disabled:opacity-45"
                title={reversible ? "Undo these file edits" : "This change is too large or binary to undo safely"}
              >
                {changeSet.undone ? <Check size={13} /> : <RotateCcw size={13} />}
                {changeSet.undone ? "Undone" : "Undo"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
