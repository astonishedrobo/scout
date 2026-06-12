import { useState } from "react";
import { ChevronDown, Check, Loader2 } from "lucide-react";
import type { ToolStep } from "scout-core";

interface ToolCardProps {
  steps: ToolStep[];
  defaultExpanded?: boolean;
}

function summarize(step: ToolStep): string {
  const { name, args } = step;
  const MAX = 60;

  if (name === "run_code") {
    const desc = String(args?.description ?? "").trim();
    if (desc) return desc.substring(0, MAX);
    const code = String(args?.code ?? "").split("\n");
    let s = code[0]?.substring(0, MAX) ?? "";
    if (code.length > 1 || (code[0]?.length ?? 0) > MAX) s += "...";
    return s;
  }
  if (name === "search_documents") return String(args?.query ?? "");
  if (name === "read_pdf") {
    let s = String(args?.path ?? "");
    if (args?.query) s += ` -> "${args.query}"`;
    return s;
  }
  if (name === "read_file") return String(args?.path ?? "");
  if (name === "exec_command") return String(args?.cmd ?? "").substring(0, MAX);
  if (name === "write_stdin") {
    const sid = args?.session_id ?? "?";
    return args?.chars ? `session ${sid}` : `poll session ${sid}`;
  }
  if (name === "think") {
    const text = String(args?.reflection ?? "");
    return text.substring(0, 80) + (text.length > 80 ? "..." : "");
  }

  const raw = JSON.stringify(args ?? {});
  return raw.length > MAX ? raw.substring(0, MAX) + "..." : raw;
}

export function ToolCard({ steps, defaultExpanded = false }: ToolCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (steps.length === 0) return null;

  const completedCount = steps.filter((s) => s.status === "complete").length;
  const isRunning = steps.some((s) => s.status === "executing");

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex items-center gap-2 text-xs text-scout-muted hover:text-scout-text transition-colors py-1"
      >
        <ChevronDown
          size={14}
          className={`transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
        />
        {isRunning && (
          <Loader2 size={12} className="animate-spin text-scout-text" />
        )}
        <span>
          {completedCount}/{steps.length} tool step
          {steps.length !== 1 ? "s" : ""}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 rounded-xl bg-scout-panel border border-scout-hairline-faint overflow-hidden">
          {steps.map((step, i) => (
            <div key={i} className={i > 0 ? "border-t border-scout-hairline-faint" : ""}>
              <div className="flex items-center gap-2 px-3 py-2">
                {step.status === "executing" ? (
                  <Loader2 size={14} className="animate-spin text-scout-text shrink-0" />
                ) : (
                  <Check size={14} className="text-scout-success shrink-0" />
                )}
                <span className="text-xs font-mono font-normal text-scout-cyan">
                  {step.name}
                </span>
                <span className="text-xs text-scout-muted truncate">
                  {summarize(step)}
                </span>
              </div>

              {step.output && (step.status === "complete" || step.status === "executing") && (
                <div className="px-3 pb-2">
                  <pre className="text-xs text-scout-muted bg-scout-canvas rounded-btn p-2 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {step.output}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
