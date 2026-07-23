import { useRef, useEffect, useState } from "react";
import { FileText, BarChart3, Compass, Clock3, Terminal, Bot, type LucideIcon } from "lucide-react";
import type { FileChangeSet, Message, ResponseAnnotation, TaskEvent, TaskNotice, ToolStep } from "scout-core";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";
import { StreamingIndicator } from "./StreamingIndicator";
import { PixelSparkle } from "./ScoutMark";
import type { Artifact } from "scout-core";

interface ChatViewProps {
  messages: Message[];
  streamingSteps: ToolStep[];
  streamingText: string;
  currentTool: string | undefined;
  statusMessage?: string;
  isLoading: boolean;
  awaitingApproval?: boolean;
  onSuggestionClick?: (text: string) => void;
  onRetry?: (assistantIndex: number) => void;
  onFork?: (messageIndex: number) => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenFileChanges?: (changeSet: FileChangeSet) => void;
  onUndoFileChanges?: (changeSet: FileChangeSet) => void;
  onOpenMemories?: () => void;
  onOpenTask?: (task: TaskEvent) => void;
  baseUrl: string;
  token: string | null;
  annotations?: ResponseAnnotation[];
  onAddAnnotation?: (annotation: Omit<ResponseAnnotation, "id" | "createdAt" | "updatedAt">) => void;
  onUpdateAnnotation?: (id: string, changes: Pick<ResponseAnnotation, "comment">) => void;
  onRemoveAnnotation?: (id: string) => void;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function TaskEventRow({ task, onOpen }: { task: TaskEvent; onOpen?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const active = task.status === "queued" || task.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const start = task.started_at ?? task.created_at;
  const end = task.finished_at ?? now / 1000;
  const elapsed = start ? formatElapsed((end - start) * 1000) : "";
  const state = task.status === "completed"
    ? "finished"
    : task.status === "cancelled"
      ? "cancelled"
      : task.status;
  const Icon = task.task_type === "terminal" ? Terminal : Bot;
  const statusColor = task.status === "failed"
    ? "bg-scout-error"
    : task.status === "completed"
      ? "bg-scout-success"
      : task.status === "cancelled" || task.status === "interrupted"
        ? "bg-scout-muted"
        : "bg-scout-accent";
  const body = task.error || task.summary || task.result_preview;
  const content = (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-scout-hairline-faint bg-scout-panel/70 px-3 py-2.5 text-left transition-colors hover:bg-scout-lift/60">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusColor} ${active ? "animate-pulse" : ""}`} />
      <Icon size={15} className="mt-0.5 shrink-0 text-scout-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] text-scout-text">
          <span className="truncate font-medium">{task.title}</span>
          <span className="shrink-0 text-scout-muted">{state}</span>
        </span>
        {body && <span className="mt-0.5 block truncate text-[12px] text-scout-muted">{body}</span>}
      </span>
      {elapsed && <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[11px] tabular-nums text-scout-muted"><Clock3 size={12} />{elapsed}</span>}
    </div>
  );
  return onOpen ? <button type="button" onClick={onOpen} className="block w-full text-left">{content}</button> : content;
}

function TaskNoticeRow({ notice }: { notice: TaskNotice }) {
  const failed = notice.status === "failed";
  const stopped = notice.status === "cancelled" || notice.status === "interrupted";
  const verb = failed ? "failed" : stopped ? "stopped" : "finished";
  return (
    <div className="flex items-center gap-2 px-1 text-[13px] text-scout-muted">
      <span className={failed ? "text-scout-error" : stopped ? "text-scout-warning" : "text-scout-success"}>●</span>
      <span className="font-medium text-scout-text">{notice.title}</span>
      <span>{verb}</span>
      {notice.summary && <span className="truncate">— {notice.summary}</span>}
    </div>
  );
}

// Fixed vivid icon colors — theme tokens desaturate in the soft/dark themes
// and wash these out to gray.
const SUGGESTIONS: {
  title: string;
  description: string;
  prompt: string;
  icon: LucideIcon;
  iconColor: string;
}[] = [
  {
    title: "Summarize workspace",
    description: "Get an overview of the files in your project",
    prompt: "Summarize the files in my workspace",
    icon: FileText,
    iconColor: "#f0a058",
  },
  {
    title: "Visualize data",
    description: "Create charts and plots from your datasets",
    prompt: "Create a chart from my data",
    icon: BarChart3,
    iconColor: "#a78bfa",
  },
  {
    title: "Explore a dataset",
    description: "Investigate patterns, stats, and outliers",
    prompt: "Help me explore a dataset",
    icon: Compass,
    iconColor: "#2cb8d8",
  },
];

export function WelcomeContent() {
  return (
    <div className="w-full text-center">
      <h1 className="relative inline-block font-display text-[clamp(1.85rem,3.2vw,2.35rem)] text-scout-text">
        <PixelSparkle size={12} className="absolute -left-6 -top-2 text-[#f5c542]" />
        What are we working on?
        <PixelSparkle size={9} className="absolute -right-5 top-1 text-[#a78bfa]" />
        <PixelSparkle size={7} className="absolute -right-9 -top-3 text-[#f0a058]" />
      </h1>
    </div>
  );
}

// Below this width a chip's title/description wrap awkwardly — instead of
// squeezing, chips drop out one by one as the container narrows (and come
// back when space returns), Codex-style.
const MIN_CHIP_WIDTH = 190;
const CHIP_GAP = 8;

export function SuggestionChips({
  onSuggestionClick,
}: {
  onSuggestionClick: (text: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(SUGGESTIONS.length);

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const fits = Math.floor((width + CHIP_GAP) / (MIN_CHIP_WIDTH + CHIP_GAP));
      setVisibleCount(Math.max(1, Math.min(SUGGESTIONS.length, fits)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={rowRef}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${visibleCount}, minmax(0, 1fr))` }}
    >
      {SUGGESTIONS.slice(0, visibleCount).map((s) => {
        const Icon = s.icon;
        return (
          <button
            key={s.prompt}
            onClick={() => onSuggestionClick(s.prompt)}
            title={s.description}
            className="group lift-hover flex items-start gap-2.5 rounded-card border border-scout-hairline-faint bg-scout-panel px-3 py-2.5 text-left hover:bg-scout-lift"
          >
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center" style={{ color: s.iconColor }}>
              <Icon size={15} strokeWidth={1.8} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-scout-text/90">{s.title}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-scout-muted/85">{s.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ChatView({
  messages,
  streamingSteps,
  streamingText,
  currentTool,
  statusMessage,
  isLoading,
  awaitingApproval = false,
  onRetry,
  onFork,
  onOpenArtifact,
  onOpenFileChanges,
  onUndoFileChanges,
  onOpenMemories,
  onOpenTask,
  baseUrl,
  token,
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const activeTool =
    currentTool ?? streamingSteps.find((step) => step.status === "executing")?.name;
  const annotationNumbers = new Map(annotations.map((annotation, index) => [annotation.id, index + 1]));

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !followsLatestRef.current) return;
    // Streaming should feel immediate and must never pull someone away from
    // an earlier result they are reading.  Browser smooth scrolling on every
    // token makes the interface visibly lag behind the model.
    element.scrollTop = element.scrollHeight;
  }, [messages, streamingSteps, streamingText, isLoading]);

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const element = scrollRef.current;
        if (!element) return;
        followsLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
      }}
      className="flex-1 min-h-0 overflow-y-auto"
    >
      <div className="max-w-[46rem] mx-auto px-4 py-8 space-y-7">
        {messages.map((msg, i) => {
          if (msg.role === "system" && msg.task) {
            return (
              <div key={`task-${msg.task.task_id}`} className="animate-enter">
                <TaskEventRow task={msg.task} onOpen={onOpenTask ? () => onOpenTask(msg.task!) : undefined} />
              </div>
            );
          }
          if (msg.role === "system" && msg.taskNotice) {
            return (
              <div key={`task-notice-${msg.taskNotice.task_id}-${i}`} className="animate-enter">
                <TaskNoticeRow notice={msg.taskNotice} />
              </div>
            );
          }
          const hasTimeline = msg.role === "assistant" && !!msg.steps?.length;
          const timelineHasText = !!msg.steps?.some((step) => step.kind === "text");
          const lastText = [...(msg.steps ?? [])]
            .reverse()
            .find((step) => step.kind === "text");
          const contentAlreadyInTimeline =
            timelineHasText
            && !!msg.content
            && (lastText?.content ?? "").trim() === msg.content.trim();
          // Always render the assistant shell when there is timeline or content
          // so copy/retry actions stay available even if prose lived in steps.
          const showBubble =
            msg.role === "user"
            || hasTimeline
            || !!msg.content
            || !!msg.stopped
            || !!msg.artifacts?.length
            || !!msg.fileChanges?.length;

          return (
            <div key={i} className="animate-enter">
              {/* Interleaved thinking / tools / mid-turn prose in event order. */}
              {hasTimeline && (
                <ToolCard
                  steps={msg.steps!}
                  baseUrl={baseUrl}
                  token={token}
                  annotationSourcePrefix={`assistant-${i}`}
                  annotations={annotations}
                  annotationNumbers={annotationNumbers}
                  onAddAnnotation={onAddAnnotation}
                  onUpdateAnnotation={onUpdateAnnotation}
                  onRemoveAnnotation={onRemoveAnnotation}
                />
              )}
              {showBubble && (
                <MessageBubble
                  message={
                    contentAlreadyInTimeline ? { ...msg, content: "" } : msg
                  }
                  onRetry={msg.role === "assistant" && onRetry ? () => onRetry(i) : undefined}
                  onFork={onFork ? () => onFork(i) : undefined}
                  onOpenArtifact={onOpenArtifact}
                  onOpenFileChanges={onOpenFileChanges}
                  onUndoFileChanges={onUndoFileChanges}
                  onOpenMemories={onOpenMemories}
                  baseUrl={baseUrl}
                  token={token}
                  sourceId={msg.role === "assistant" ? `assistant-${i}-message` : undefined}
                  annotations={msg.role === "assistant" ? annotations.filter((annotation) => annotation.sourceId === `assistant-${i}-message`) : []}
                  annotationNumbers={annotationNumbers}
                  onAddAnnotation={onAddAnnotation}
                  onUpdateAnnotation={onUpdateAnnotation}
                  onRemoveAnnotation={onRemoveAnnotation}
                />
              )}
            </div>
          );
        })}

        {isLoading && (
          <div>
            {streamingSteps.length > 0 && (
              <ToolCard
                steps={streamingSteps}
                defaultExpanded
                baseUrl={baseUrl}
                token={token}
                awaitingApproval={awaitingApproval}
                annotationSourcePrefix="streaming"
                annotations={annotations}
                annotationNumbers={annotationNumbers}
                onAddAnnotation={onAddAnnotation}
                onUpdateAnnotation={onUpdateAnnotation}
                onRemoveAnnotation={onRemoveAnnotation}
              />
            )}
            {streamingText ? (
              <div className="prose-scout text-[15px]">
                <MessageBubble
                  message={{ role: "assistant", content: streamingText }}
                  baseUrl={baseUrl}
                  token={token}
                  sourceId="streaming-message"
                  annotations={annotations.filter((annotation) => annotation.sourceId === "streaming-message")}
                  annotationNumbers={annotationNumbers}
                  onAddAnnotation={onAddAnnotation}
                  onUpdateAnnotation={onUpdateAnnotation}
                  onRemoveAnnotation={onRemoveAnnotation}
                />
              </div>
            ) : null}
            <StreamingIndicator
              currentTool={activeTool}
              text={streamingText}
              statusMessage={statusMessage}
              hasToolSteps={streamingSteps.length > 0}
            />
          </div>
        )}
      </div>
    </div>
  );
}
