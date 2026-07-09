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

const rowTone = {
  add: "bg-scout-success-muted",
  delete: "bg-scout-error-muted",
  context: "bg-transparent",
  hunk: "bg-scout-cyan/5 text-scout-cyan",
  meta: "bg-scout-lift/45 text-scout-muted italic",
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
      className={`overflow-auto bg-scout-code-bg/75 font-mono text-[12px] leading-[1.65] ${className}`}
      style={{ maxHeight }}
      role="region"
      aria-label="Unified file diff"
      tabIndex={0}
    >
      <div className="min-w-max">
        {rows.map((row, index) => {
          if (row.kind === "hunk" || row.kind === "meta") {
            return (
              <div
                key={index}
                className={`grid grid-cols-[44px_44px_minmax(20rem,1fr)] border-b border-scout-hairline-faint ${rowTone[row.kind]}`}
              >
                <span className="border-r border-scout-hairline-faint" />
                <span className="border-r border-scout-hairline-faint" />
                <span className="px-3 py-1 whitespace-pre">{row.content}</span>
              </div>
            );
          }
          return (
            <div
              key={index}
              className={`grid grid-cols-[44px_44px_minmax(20rem,1fr)] border-b border-scout-hairline-faint/60 last:border-b-0 ${rowTone[row.kind]}`}
            >
              <span className="select-none border-r border-scout-hairline-faint px-2 text-right tabular-nums text-scout-muted/55">
                {row.oldLine ?? ""}
              </span>
              <span className="select-none border-r border-scout-hairline-faint px-2 text-right tabular-nums text-scout-muted/55">
                {row.newLine ?? ""}
              </span>
              <span className="grid grid-cols-[20px_1fr] whitespace-pre px-1">
                <span className={`select-none text-center ${row.kind === "add" ? "text-scout-success" : row.kind === "delete" ? "text-scout-error" : "text-scout-muted/45"}`}>
                  {prefix[row.kind]}
                </span>
                <span className="pr-3 text-scout-text/90">{row.content || " "}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
