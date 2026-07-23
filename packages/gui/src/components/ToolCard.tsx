import { useState } from "react";
import {
  ChevronRight,
  FileText,
  FolderOpen,
  PencilLine,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ResponseAnnotation, ToolStep } from "scout-core";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { AnnotationRegion } from "./AnnotationRegion";

interface ToolCardProps {
  steps: ToolStep[];
  /** When true, expand tool-group details by default (streaming). */
  defaultExpanded?: boolean;
  baseUrl?: string;
  token?: string | null;
  awaitingApproval?: boolean;
  annotationSourcePrefix?: string;
  annotations?: ResponseAnnotation[];
  annotationNumbers?: Map<string, number>;
  onAddAnnotation?: (annotation: Omit<ResponseAnnotation, "id" | "createdAt" | "updatedAt">) => void;
  onUpdateAnnotation?: (id: string, changes: Pick<ResponseAnnotation, "comment">) => void;
  onRemoveAnnotation?: (id: string) => void;
}

type TimelineSegment =
  | { kind: "text"; content: string }
  | { kind: "tools"; title: string; steps: ToolStep[] };

function pathFrom(step: ToolStep): string {
  if (step.name === "present_files") {
    const paths = step.args?.filepaths ?? step.args?.paths;
    if (Array.isArray(paths) && paths.length > 0) {
      return String(paths[0] ?? "").trim();
    }
  }
  return String(step.args?.path ?? step.args?.file ?? step.args?.directory ?? "").trim();
}

function filename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path || "";
}

function displayName(step: ToolStep, tense: "present" | "past" | "stopped" = "past"): string {
  const path = pathFrom(step);
  const file = filename(path);
  if (tense === "stopped") {
    switch (step.name) {
      case "write_file":
      case "write_binary_artifact":
        return `Stopped creating ${file || "a file"}`;
      case "apply_patch":
        return "Stopped updating files";
      case "read_file":
        return `Stopped reading ${file || "a file"}`;
      case "list_files":
        return "Stopped checking files";
      case "search_workspace":
        return "Stopped searching workspace";
      case "filter_table":
        return "Stopped filtering table";
      case "exec_command":
        return "Stopped running command";
      case "run_node":
        return "Stopped running JavaScript";
      case "write_stdin":
        return "Stopped checking command output";
      case "memory_add_note":
        return "Stopped updating memory";
      case "present_files":
        return file
          ? `Stopped presenting ${file}`
          : "Stopped presenting files";
      case "spawn_subagent":
        return "Stopped launching agent";
      case "send_subagent_message":
        return "Stopped messaging agent";
      default:
        return "Stopped tool";
    }
  }
  switch (step.name) {
    case "write_file":
    case "write_binary_artifact":
      return tense === "present"
        ? `Creating ${file || "a file"}`
        : `Created ${file || "a file"}`;
    case "apply_patch":
      return tense === "present" ? "Updating files" : "Updated files";
    case "present_files": {
      const paths = step.args?.filepaths ?? step.args?.paths;
      const count = Array.isArray(paths) ? paths.length : file ? 1 : 0;
      if (tense === "present") {
        return count > 1 ? `Presenting ${count} files` : `Presenting ${file || "a file"}`;
      }
      return count > 1 ? `Presented ${count} files` : `Presented ${file || "a file"}`;
    }
    case "read_file":
      return tense === "present"
        ? `Reading ${file || "a file"}`
        : `Read ${file || "a file"}`;
    case "list_files":
      return tense === "present" ? "Checking files" : "Checked files";
    case "search_workspace":
      return tense === "present" ? "Searching workspace" : "Searched workspace";
    case "filter_table":
      return tense === "present" ? "Filtering table" : "Filtered table";
    case "exec_command":
      return tense === "present" ? "Running command" : "Ran command";
    case "run_node":
      return tense === "present" ? "Running JavaScript" : "Ran JavaScript";
    case "write_stdin":
      return tense === "present" ? "Checking command output" : "Checked command output";
    case "memory_add_note":
      return tense === "present" ? "Updating memory" : "Updated memory";
    case "spawn_subagent":
      return tense === "present" ? "Launching agent" : "Launched agent";
    case "send_subagent_message":
      return tense === "present" ? "Messaging agent" : "Messaged agent";
    case "list_subagents":
      return tense === "present" ? "Checking agents" : "Checked agents";
    case "get_subagent_result":
      return tense === "present" ? "Reading agent result" : "Read agent result";
    case "stop_subagent":
      return tense === "present" ? "Stopping agent" : "Stopped agent";
    default:
      return tense === "present" ? "Using a tool" : "Used a tool";
  }
}

function detailText(step: ToolStep): string {
  if (step.name === "search_workspace" || step.name === "filter_table") {
    const q = String(step.args?.query ?? "");
    const p = String(step.args?.path ?? "");
    if (q && p) return `${q} · ${p}`;
    return q || p || pathFrom(step) || "";
  }
  const path = pathFrom(step);
  if (path) return path;
  if (step.name === "exec_command") return String(step.args?.cmd ?? "");
  if (step.name === "run_node") {
    return String(step.args?.description ?? step.args?.code ?? "").split("\n")[0] ?? "";
  }
  return "";
}

function iconFor(step: ToolStep) {
  // Tool-type icons only — no status-colored spinners/ticks/stops.
  if (step.name === "write_file" || step.name === "write_binary_artifact") return FileText;
  if (step.name === "present_files") return FileText;
  if (step.name === "apply_patch") return PencilLine;
  if (step.name === "read_file") return FileText;
  if (step.name === "list_files") return FolderOpen;
  if (step.name === "search_workspace" || step.name === "filter_table") return Search;
  if (step.name === "exec_command" || step.name === "run_node" || step.name === "write_stdin") {
    return Terminal;
  }
  return Wrench;
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

function stepTense(step: ToolStep): "present" | "past" | "stopped" {
  if (step.status === "executing") return "present";
  if (step.status === "interrupted") return "stopped";
  return "past";
}

function deriveToolGroupTitle(tools: ToolStep[]): string {
  if (tools.length === 0) return "Working";
  if (tools.length === 1) {
    return displayName(tools[0]!, stepTense(tools[0]!));
  }
  if (tools.some((step) => step.status === "executing")) return "Running tools";
  if (tools.some((step) => step.status === "interrupted")) return "Stopped tools";
  return "Completed tools";
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
        <Icon size={13} className="mt-0.5 shrink-0 text-scout-muted" />
        <div className="min-w-0">
          <div className="text-scout-text/80">
            {displayName(step, stepTense(step))}
          </div>
          {detail && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-scout-muted/75">
              {detail}
            </div>
          )}
        </div>
      </button>
      {expanded && hasOutput && (
        <pre className="ml-8 max-h-40 overflow-auto rounded-btn border border-scout-hairline-faint bg-scout-code-bg/90 p-2.5 text-xs text-scout-muted whitespace-pre-wrap">
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
  awaitingApproval = false,
}: {
  title: string;
  steps: ToolStep[];
  defaultExpanded?: boolean;
  awaitingApproval?: boolean;
}) {
  const running = steps.some((step) => step.status === "executing");
  const [expanded, setExpanded] = useState(defaultExpanded ?? running);

  return (
    <div className="rounded-card border border-scout-hairline-faint bg-scout-lift/30">
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
            {awaitingApproval && running
              ? "Waiting for approval"
              : running
                ? "Working"
                : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
          </div>
          <div className="text-scout-text/85 leading-relaxed">{title}</div>
        </div>
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
  sourceId,
  annotations,
  annotationNumbers,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: {
  content: string;
  baseUrl?: string;
  token?: string | null;
  sourceId?: string;
  annotations?: ResponseAnnotation[];
  annotationNumbers?: Map<string, number>;
  onAddAnnotation?: (annotation: Omit<ResponseAnnotation, "id" | "createdAt" | "updatedAt">) => void;
  onUpdateAnnotation?: (id: string, changes: Pick<ResponseAnnotation, "comment">) => void;
  onRemoveAnnotation?: (id: string) => void;
}) {
  if (!content.trim()) return null;
  const body = (
    <div className="prose-scout text-[15px] overflow-x-auto">
      <MarkdownRenderer content={content} baseUrl={baseUrl} token={token} />
    </div>
  );
  return sourceId && onAddAnnotation && onUpdateAnnotation && onRemoveAnnotation ? (
    <AnnotationRegion sourceId={sourceId} annotations={annotations ?? []} annotationNumbers={annotationNumbers ?? new Map()} onAdd={onAddAnnotation} onUpdate={onUpdateAnnotation} onRemove={onRemoveAnnotation}>
      {body}
    </AnnotationRegion>
  ) : body;
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
  awaitingApproval = false,
  annotationSourcePrefix,
  annotations = [],
  annotationNumbers = new Map(),
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
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
              sourceId={annotationSourcePrefix ? `${annotationSourcePrefix}-timeline-${index}` : undefined}
              annotations={annotationSourcePrefix ? annotations.filter((annotation) => annotation.sourceId === `${annotationSourcePrefix}-timeline-${index}`) : []}
              annotationNumbers={annotationNumbers}
              onAddAnnotation={onAddAnnotation}
              onUpdateAnnotation={onUpdateAnnotation}
              onRemoveAnnotation={onRemoveAnnotation}
            />
          );
        }
        return (
          <ToolGroupCard
            key={`tools-${index}`}
            title={segment.title}
            steps={segment.steps}
            defaultExpanded={defaultExpanded}
            awaitingApproval={awaitingApproval}
          />
        );
      })}
    </div>
  );
}
