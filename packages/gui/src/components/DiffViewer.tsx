import { useState } from "react";
type DiffRow = {
  kind: "add" | "delete" | "context" | "hunk" | "meta" | "file";
  oldLine: number | null;
  newLine: number | null;
  content: string;
  /** file rows only: +N / -M for that file. */
  stats?: { additions: number; deletions: number };
};

/** Path from a `diff --git a/x b/x` / `+++ b/x` / `--- a/x` header. */
function headerPath(line: string): string | null {
  const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (git) return git[2] ?? git[1] ?? null;
  const plus = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
  if (plus) return plus[1] === "/dev/null" ? null : plus[1];
  const minus = line.match(/^--- (?:a\/)?(.+)$/);
  if (minus) return minus[1] === "/dev/null" ? null : minus[1];
  return null;
}

function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  // Index of the file row currently being counted into, so a multi-file diff
  // gets a per-file +N/-M rather than one undifferentiated stream.
  let fileRow = -1;

  const startFile = (path: string) => {
    if (fileRow >= 0 && rows[fileRow]!.content === path) return;
    rows.push({
      kind: "file",
      oldLine: null,
      newLine: null,
      content: path,
      stats: { additions: 0, deletions: 0 },
    });
    fileRow = rows.length - 1;
  };

  for (const rawLine of diff.split("\n")) {
    // File headers used to be dropped outright, which is why a multi-file diff
    // arrived with no filenames at all.
    if (rawLine.startsWith("diff --git") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
      const path = headerPath(rawLine);
      if (path) startFile(path);
      continue;
    }
    if (
      rawLine.startsWith("index ")
      || rawLine.startsWith("new file mode")
      || rawLine.startsWith("deleted file mode")
      || rawLine.startsWith("similarity index")
      || rawLine.startsWith("rename from")
      || rawLine.startsWith("rename to")
    ) {
      continue;
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({
        kind: "hunk",
        oldLine: null,
        newLine: null,
        content: hunk[3]?.trim() || rawLine,
      });
      continue;
    }

    if (rawLine.startsWith("\\ No newline")) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, content: rawLine });
      continue;
    }
    if (rawLine.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine, content: rawLine.slice(1) });
      newLine += 1;
      if (fileRow >= 0) rows[fileRow]!.stats!.additions += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      rows.push({ kind: "delete", oldLine, newLine: null, content: rawLine.slice(1) });
      oldLine += 1;
      if (fileRow >= 0) rows[fileRow]!.stats!.deletions += 1;
      continue;
    }

    rows.push({
      kind: "context",
      oldLine,
      newLine,
      content: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
    });
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

// GitHub-style tones: content cell gets a soft tint, the line-number gutter a
// slightly stronger one so changed regions read at a glance while scanning.
const rowTone = {
  file: "bg-scout-lift/70",
  add: "bg-scout-success-muted",
  delete: "bg-scout-error-muted",
  context: "bg-transparent",
  hunk: "bg-scout-cyan/10 text-scout-cyan",
  meta: "bg-scout-lift/45 text-scout-muted italic",
};

const gutterTone = {
  add: "bg-scout-success/20 text-scout-success/80",
  delete: "bg-scout-error/20 text-scout-error/80",
  context: "text-scout-muted/50",
};

/**
 * ASCII `-`, not U+2212. The gutter column is part of the copyable text, so
 * rendering a typographic minus produced a diff that no longer applies when
 * pasted into `git apply`.
 */
const prefix = {
  add: "+",
  delete: "-",
  context: " ",
  hunk: "",
  meta: "",
  file: "",
};

/**
 * Rows render in chunks rather than all at once.
 *
 * True windowing is not workable here: rows soft-wrap, so their heights are
 * variable and unknown before layout. Chunking gets the important property —
 * a 20,000-line diff no longer builds 20,000 DOM nodes on mount — without
 * pretending to measure what it cannot.
 */
const ROW_CHUNK = 600;

export function DiffViewer({
  diff,
  maxHeight = "32rem",
  className = "",
  showFilenames = true,
}: {
  diff: string;
  maxHeight?: string;
  className?: string;
  /** Set false where the caller already labels the file above the diff. */
  showFilenames?: boolean;
}) {
  const parsed = parseUnifiedDiff(diff);
  const allRows = showFilenames ? parsed : parsed.filter((row) => row.kind !== "file");
  const [visibleCount, setVisibleCount] = useState(ROW_CHUNK);
  const rows = allRows.length > visibleCount ? allRows.slice(0, visibleCount) : allRows;
  const hidden = allRows.length - rows.length;
  if (!rows.length) {
    // Three genuinely different situations used to share one message.
    const message = !diff.trim()
      ? "No changes to show"
      : /^Binary files|GIT binary patch/m.test(diff)
        ? "Binary file - no textual diff"
        : "Could not parse this diff";
    return <div className="px-4 py-8 text-center text-caption text-scout-muted">{message}</div>;
  }

  // Widen the gutters when the file is long enough for 5-digit line numbers;
  // the fixed 40px columns clipped them. Measured over ALL rows, so the columns
  // do not shift when more rows are revealed.
  const widestLine = allRows.reduce(
    (max, row) => Math.max(max, row.oldLine ?? 0, row.newLine ?? 0),
    0,
  );
  const gutter = widestLine >= 10000 ? 56 : widestLine >= 1000 ? 48 : 40;

  return (
    <div
      className={`overflow-y-auto bg-scout-code-bg/75 font-mono text-caption leading-[1.6] ${className}`}
      style={{ maxHeight }}
      role="region"
      aria-label="Unified file diff"
      tabIndex={0}
    >
      {rows.map((row, index) => {
        if (row.kind === "file") {
          return (
            <div
              key={index}
              className={`sticky top-0 z-10 flex items-center gap-2 border-y border-scout-hairline-faint px-3 py-1.5 backdrop-blur-sm ${rowTone.file}`}
            >
              <span className="min-w-0 flex-1 truncate text-caption font-semibold text-scout-text" title={row.content}>
                {row.content}
              </span>
              {row.stats && (
                <span className="shrink-0 text-micro tabular-nums">
                  <span className="text-scout-success">+{row.stats.additions}</span>{" "}
                  <span className="text-scout-error">-{row.stats.deletions}</span>
                </span>
              )}
            </div>
          );
        }
        if (row.kind === "hunk") {
          return (
            <div key={index} className={`px-3 py-1.5 ${rowTone.hunk}`}>
              <span className="whitespace-pre-wrap break-words text-scout-cyan/80">
                {row.content}
              </span>
            </div>
          );
        }
        if (row.kind === "meta") {
          return (
            <div key={index} className={`px-3 py-1 ${rowTone.meta}`}>
              {row.content}
            </div>
          );
        }
        return (
          <div
            key={index}
            className={`grid ${rowTone[row.kind]}`}
            style={{ gridTemplateColumns: `${gutter}px ${gutter}px 16px 1fr` }}
          >
            <span className={`select-none px-2 text-right tabular-nums ${gutterTone[row.kind]}`}>
              {row.oldLine ?? ""}
            </span>
            <span className={`select-none px-2 text-right tabular-nums ${gutterTone[row.kind]}`}>
              {row.newLine ?? ""}
            </span>
            <span
              className={`select-none text-center ${
                row.kind === "add"
                  ? "text-scout-success"
                  : row.kind === "delete"
                    ? "text-scout-error"
                    : "text-scout-muted/40"
              }`}
            >
              {prefix[row.kind]}
            </span>
            {/* GitHub-style soft wrap: long lines break within the content
                column instead of forcing horizontal scroll. */}
            <span className="min-w-0 whitespace-pre-wrap break-words pl-1 pr-3 text-scout-text/90">
              {row.content || " "}
            </span>
          </div>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => count + ROW_CHUNK)}
          className="w-full border-t border-scout-hairline-faint bg-scout-lift/50 px-3 py-2 text-center text-caption font-medium text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
        >
          Show {Math.min(hidden, ROW_CHUNK)} more of {hidden} remaining lines
        </button>
      )}
    </div>
  );
}
