import { useState } from "react";
import {
  Check,
  ChevronRight,
  CircleDashed,
  FileText,
  FolderOpen,
  Loader2,
  PencilLine,
  Search,
  Terminal,
} from "lucide-react";
import type { ToolStep } from "scout-core";

interface ToolCardProps {
  steps: ToolStep[];
  defaultExpanded?: boolean;
}

type ToolGroup = {
  key: string;
  reflections: string[];
  steps: ToolStep[];
};

function pathFrom(step: ToolStep): string {
  return String(step.args?.path ?? step.args?.file ?? step.args?.directory ?? "").trim();
}

function filename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path || "";
}

function displayName(step: ToolStep, tense: "present" | "past" = "past"): string {
  const path = pathFrom(step);
  const file = filename(path);
  switch (step.name) {
    case "write_file":
    case "write_binary_artifact":
      return tense === "present"
        ? `Creating ${file || "a file"}`
        : `Created ${file || "a file"}`;
    case "apply_patch":
      return tense === "present" ? "Updating files" : "Updated files";
    case "read_file":
      return tense === "present"
        ? `Reading ${file || "a file"}`
        : `Read ${file || "a file"}`;
    case "list_files":
      return tense === "present" ? "Checking files" : "Checked files";
    case "search_documents":
      return tense === "present" ? "Searching documents" : "Searched documents";
    case "read_pdf":
      return tense === "present"
        ? `Reading ${file || "PDF"}`
        : `Read ${file || "PDF"}`;
    case "exec_command":
      return tense === "present" ? "Running command" : "Ran command";
    case "run_node":
      return tense === "present" ? "Running JavaScript" : "Ran JavaScript";
    case "run_python":
    case "run_code":
      return tense === "present" ? "Running Python" : "Ran Python";
    case "write_stdin":
      return tense === "present" ? "Checking command output" : "Checked command output";
    case "memory_add_note":
      return tense === "present" ? "Updating memory" : "Updated memory";
    default:
      return tense === "present" ? "Using a tool" : "Used a tool";
  }
}

function detailText(step: ToolStep): string {
  const path = pathFrom(step);
  if (path) return path;
  if (step.name === "search_documents") return String(step.args?.query ?? "");
  if (step.name === "exec_command") return String(step.args?.cmd ?? "");
  if (step.name === "run_python" || step.name === "run_code" || step.name === "run_node") {
    return String(step.args?.description ?? step.args?.code ?? "").split("\n")[0] ?? "";
  }
  return "";
}

function iconFor(step: ToolStep) {
  if (step.status === "executing") return Loader2;
  if (step.name === "write_file" || step.name === "write_binary_artifact") return FileText;
  if (step.name === "apply_patch") return PencilLine;
  if (step.name === "read_file" || step.name === "read_pdf") return FileText;
  if (step.name === "list_files") return FolderOpen;
  if (step.name === "search_documents") return Search;
  if (step.name === "exec_command" || step.name === "run_python" || step.name === "run_code" || step.name === "run_node") return Terminal;
  return Check;
}

function groupTitle(group: ToolGroup): string {
  const reflectionTitle = group.reflections.find(Boolean);
  if (reflectionTitle) {
    const firstSentence = reflectionTitle.split(/(?<=[.!?])\s+/)[0] ?? reflectionTitle;
    return firstSentence.length > 86 ? `${firstSentence.slice(0, 83)}...` : firstSentence;
  }

  const running = group.steps.some((step) => step.status === "executing");
  const names = group.steps.map((step) => displayName(step, running ? "present" : "past"));
  const unique = names.filter((name, index) => names.indexOf(name) === index);
  if (unique.length === 0) return running ? "Working" : "Completed work";
  if (unique.length === 1) return unique[0] ?? "";
  if (unique.length === 2) return `${unique[0]}, ${unique[1]}`;
  return `${unique.slice(0, 2).join(", ")} + ${unique.length - 2} more`;
}

function buildGroups(steps: ToolStep[]): ToolGroup[] {
  const items: ToolGroup[] = [];
  let current: ToolGroup = { key: "group-0", reflections: [], steps: [] };

  const flush = () => {
    if (!current.reflections.length && !current.steps.length) return;
    items.push({ ...current, key: `group-${items.length}` });
    current = { key: `group-${items.length + 1}`, reflections: [], steps: [] };
  };

  for (const step of steps) {
    if (step.kind === "reflection") {
      const text = (step.reflection ?? step.output ?? "").trim();
      if (!text) continue;
      if (current.steps.length > 0) flush();
      current.reflections.push(text);
    } else {
      current.steps.push(step);
    }
  }
  flush();
  return items;
}

function hasOutput(group: ToolGroup): boolean {
  return group.steps.some((step) => step.output && step.name !== "memory_add_note");
}

function ActivityGroup({ group, defaultExpanded }: { group: ToolGroup; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const running = group.steps.some((step) => step.status === "executing");
  const outputAvailable = hasOutput(group);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex items-center gap-2 text-left text-xs text-scout-muted hover:text-scout-text transition-colors"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        {running ? (
          <Loader2 size={13} className="animate-spin shrink-0" />
        ) : (
          <Check size={13} className="text-scout-success shrink-0" />
        )}
        <span>{groupTitle(group)}</span>
      </button>

      {expanded && (
        <div className="ml-[6px] border-l border-scout-hairline-faint pl-4 pt-1 space-y-2">
          {group.reflections.map((text, index) => (
            <div key={`reflection-${index}`} className="flex items-start gap-2 text-xs text-scout-muted">
              <CircleDashed size={13} className="mt-0.5 shrink-0 text-scout-muted/80" />
              <p className="leading-relaxed">{text}</p>
            </div>
          ))}
          {group.steps.map((step, index) => {
            const Icon = iconFor(step);
            const detail = detailText(step);
            return (
              <div key={index} className="space-y-1.5">
                <div className="flex min-w-0 items-start gap-2 text-xs text-scout-muted">
                  <Icon
                    size={13}
                    className={`${step.status === "executing" ? "animate-spin" : ""} mt-0.5 shrink-0`}
                  />
                  <div className="min-w-0">
                    <div className="text-scout-text/80">{displayName(step, step.status === "executing" ? "present" : "past")}</div>
                    {detail && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-scout-muted/75">
                        {detail}
                      </div>
                    )}
                  </div>
                </div>
                {outputAvailable && step.output && step.name !== "memory_add_note" && (
                  <details className="ml-5">
                    <summary className="cursor-pointer list-none text-[11px] text-scout-muted/75 hover:text-scout-text">
                      Show output
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto rounded-xl border border-scout-hairline-faint bg-scout-code-bg/90 p-2.5 text-xs text-scout-muted whitespace-pre-wrap">
                      {step.output}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ToolCard({ steps, defaultExpanded = false }: ToolCardProps) {
  if (steps.length === 0) return null;

  return (
    <div className="mb-4 space-y-3 text-scout-muted">
      {buildGroups(steps).map((group) => (
        <ActivityGroup
          key={group.key}
          group={group}
          defaultExpanded={defaultExpanded}
        />
      ))}
    </div>
  );
}
