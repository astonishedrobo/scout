import { PathLabel } from "./PathLabel";
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
            className={`flex w-full max-w-[45rem] items-center gap-2.5 rounded-btn border border-scout-hairline-faint px-3 py-2.5 ${
              changeSet.undone ? "bg-scout-success-muted" : "bg-scout-card-peach"
            }`}
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-btn ${
                changeSet.undone
                  ? "bg-scout-success/15 text-scout-success"
                  : "bg-scout-peach-muted text-scout-peach"
              }`}
            >
              {changeSet.undone ? <Check size={17} /> : <FilePenLine size={17} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-semibold text-scout-text">
                {changeSet.undone ? "Undo applied" : `Edited ${count} file${count === 1 ? "" : "s"}`}
              </span>
              <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-caption text-scout-muted">
                {changeSet.entries.slice(0, 3).map((entry) => (
                  <span key={entry.path} className="flex min-w-0 items-baseline gap-1">
                    <span className={`shrink-0 ${statusTone(entry.status)}`}>●</span>
                    <PathLabel path={entry.path} />
                  </span>
                ))}
                {changeSet.entries.length > 3 && (
                  <button
                    type="button"
                    onClick={() => onReview(changeSet)}
                    className="shrink-0 font-medium underline underline-offset-2 hover:text-scout-text"
                  >
                    +{changeSet.entries.length - 3} more
                  </button>
                )}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => onReview(changeSet)}
                className="inline-flex items-center gap-1.5 rounded-btn border border-scout-hairline-faint bg-scout-input-bg/80 px-3 py-2 text-caption font-semibold text-scout-text hover:bg-scout-lift transition-colors"
              >
                <GitCompareArrows size={13} />
                Review
              </button>
              <button
                type="button"
                disabled={!reversible || !!changeSet.undone}
                onClick={() => onUndo(changeSet)}
                className="inline-flex items-center gap-1.5 rounded-btn border border-scout-hairline-faint bg-scout-input-bg/80 px-3 py-2 text-caption font-semibold text-scout-text hover:bg-scout-lift transition-colors disabled:cursor-not-allowed disabled:opacity-45"
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
