import { useState } from "react";
import {
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  PencilLine,
  Search,
  Terminal,
} from "lucide-react";
import type { ToolStep } from "scout-core";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface ToolCardProps {
  steps: ToolStep[];
  /** When true, expand tool-group details by default (streaming). */
  defaultExpanded?: boolean;
  baseUrl?: string;
  token?: string | null;
}

type TimelineSegment =
  | { kind: "text"; content: string }
  | { kind: "tools"; title: string; steps: ToolStep[] };

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
  if (step.name === "exec_command" || step.name === "run_python" || step.name === "run_code" || step.name === "run_node") {
    return Terminal;
  }
  return Check;
}

function isThinking(step: ToolStep): boolean {
  return step.kind === "thinking" || step.kind === "reflection" || step.name === "think";
}

function isText(step: ToolStep): boolean {
  return step.kind === "text";
}

function thinkingBody(step: ToolStep): string {
  return (step.reflection ?? step.content ?? "").trim();
}

function deriveToolGroupTitle(tools: ToolStep[]): string {
  if (tools.length === 0) return "Working";
  if (tools.length === 1) {
    return displayName(tools[0]!, tools[0]!.status === "executing" ? "present" : "past");
  }
  const running = tools.some((step) => step.status === "executing");
  return running ? "Running tools" : "Completed tools";
}

/**
 * Build a Claude-like interleaved timeline:
 * - `think` content → main prose
 * - `think` title → labels the following tool card
 * - tools → expandable activity card (the nice card chrome)
 * - assistant_text → main prose
 */
function buildTimeline(steps: ToolStep[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let pendingTitle = "";
  let toolBuffer: ToolStep[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    const title = pendingTitle || deriveToolGroupTitle(toolBuffer);
    segments.push({ kind: "tools", title, steps: toolBuffer });
    toolBuffer = [];
    pendingTitle = "";
  };

  for (const step of steps) {
    if (isThinking(step)) {
      flushTools();
      const body = thinkingBody(step);
      const title = (step.title ?? "").trim();
      // Prose the model put in think.content is user-facing main text.
      if (body) {
        segments.push({ kind: "text", content: body });
      }
      // Title names the next tool group (e.g. "Plan demo").
      if (title) {
        pendingTitle = title;
      }
      continue;
    }

    if (isText(step)) {
      flushTools();
      const content = (step.content ?? step.reflection ?? "").trim();
      if (content) {
        segments.push({ kind: "text", content });
      }
      continue;
    }

    toolBuffer.push(step);
  }

  flushTools();
  // Orphan title with no tools: nothing to show (title only labels tools).
  return segments;
}

function ToolRow({
  step,
  defaultExpanded,
}: {
  step: ToolStep;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const Icon = iconFor(step);
  const detail = detailText(step);
  const hasOutput = Boolean(step.output && step.name !== "memory_add_note");

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((value) => !value)}
        className={`group flex w-full items-start gap-2 text-left text-xs text-scout-muted ${
          hasOutput ? "hover:text-scout-text cursor-pointer" : "cursor-default"
        } transition-colors`}
      >
        {hasOutput ? (
          <ChevronRight
            size={13}
            className={`mt-0.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <Icon
          size={13}
          className={`${step.status === "executing" ? "animate-spin" : ""} mt-0.5 shrink-0`}
        />
        <div className="min-w-0">
          <div className="text-scout-text/80">
            {displayName(step, step.status === "executing" ? "present" : "past")}
          </div>
          {detail && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-scout-muted/75">
              {detail}
            </div>
          )}
        </div>
        {step.status === "complete" && !hasOutput && (
          <Check size={12} className="ml-auto mt-0.5 shrink-0 text-scout-success" />
        )}
      </button>
      {expanded && hasOutput && (
        <pre className="ml-8 max-h-40 overflow-auto rounded-xl border border-scout-hairline-faint bg-scout-code-bg/90 p-2.5 text-xs text-scout-muted whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
    </div>
  );
}

/**
 * Expandable activity card (same chrome as the previous thinking card).
 * Holds one or more tool steps under a short phase title.
 */
function ToolGroupCard({
  title,
  steps,
  defaultExpanded,
}: {
  title: string;
  steps: ToolStep[];
  defaultExpanded?: boolean;
}) {
  const running = steps.some((step) => step.status === "executing");
  const [expanded, setExpanded] = useState(defaultExpanded ?? running);

  return (
    <div className="rounded-xl border border-scout-hairline-faint bg-scout-lift/30">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs text-scout-muted hover:text-scout-text transition-colors"
      >
        <ChevronRight
          size={13}
          className={`mt-0.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-scout-muted/70 mb-0.5">
            {running ? "Working" : "Activity"}
          </div>
          <div className="text-scout-text/85 leading-relaxed">{title}</div>
        </div>
        {running ? (
          <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
        ) : (
          <Check size={13} className="mt-0.5 shrink-0 text-scout-success" />
        )}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-scout-hairline-faint px-3 py-2.5">
          {steps.map((step, index) => (
            <ToolRow
              key={`${step.name}-${index}`}
              step={step}
              defaultExpanded={running && step.status === "executing"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TextBlock({
  content,
  baseUrl,
  token,
}: {
  content: string;
  baseUrl?: string;
  token?: string | null;
}) {
  if (!content.trim()) return null;
  return (
    <div className="prose-scout text-[15px] overflow-x-auto">
      <MarkdownRenderer content={content} baseUrl={baseUrl} token={token} />
    </div>
  );
}

/**
 * Chronological turn timeline:
 * main prose interleaved with expandable tool-activity cards.
 */
export function ToolCard({
  steps,
  defaultExpanded = false,
  baseUrl = "",
  token = null,
}: ToolCardProps) {
  if (steps.length === 0) return null;

  const segments = buildTimeline(steps);
  if (segments.length === 0) return null;

  return (
    <div className="mb-4 space-y-3 text-scout-muted">
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return (
            <TextBlock
              key={`text-${index}`}
              content={segment.content}
              baseUrl={baseUrl}
              token={token}
            />
          );
        }
        return (
          <ToolGroupCard
            key={`tools-${index}`}
            title={segment.title}
            steps={segment.steps}
            defaultExpanded={defaultExpanded}
          />
        );
      })}
    </div>
  );
}
