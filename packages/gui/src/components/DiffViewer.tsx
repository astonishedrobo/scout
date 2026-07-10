type DiffRow = {
  kind: "add" | "delete" | "context" | "hunk" | "meta";
  oldLine: number | null;
  newLine: number | null;
  content: string;
};

function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diff.split("\n")) {
    if (
      rawLine.startsWith("diff --git")
      || rawLine.startsWith("index ")
      || rawLine.startsWith("new file mode")
      || rawLine.startsWith("deleted file mode")
      || rawLine.startsWith("--- ")
      || rawLine.startsWith("+++ ")
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
      continue;
    }
    if (rawLine.startsWith("-")) {
      rows.push({ kind: "delete", oldLine, newLine: null, content: rawLine.slice(1) });
      oldLine += 1;
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

const prefix = {
  add: "+",
  delete: "−",
  context: " ",
  hunk: "",
  meta: "",
};

export function DiffViewer({
  diff,
  maxHeight = "32rem",
  className = "",
}: {
  diff: string;
  maxHeight?: string;
  className?: string;
}) {
  const rows = parseUnifiedDiff(diff);
  if (!rows.length) {
    return <div className="px-4 py-8 text-center text-xs text-scout-muted">No textual diff available</div>;
  }

  return (
    <div
      className={`overflow-y-auto bg-scout-code-bg/75 font-mono text-[12px] leading-[1.6] ${className}`}
      style={{ maxHeight }}
      role="region"
      aria-label="Unified file diff"
      tabIndex={0}
    >
      {rows.map((row, index) => {
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
          <div key={index} className={`grid grid-cols-[40px_40px_16px_1fr] ${rowTone[row.kind]}`}>
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
    </div>
  );
}
