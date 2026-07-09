import { useRef, useEffect } from "react";
import { FileText, BarChart3, Compass, type LucideIcon } from "lucide-react";
import type { FileChangeSet, Message, ToolStep } from "scout-core";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";
import { StreamingIndicator } from "./StreamingIndicator";
import type { Artifact } from "scout-core";

interface ChatViewProps {
  messages: Message[];
  streamingSteps: ToolStep[];
  streamingText: string;
  currentTool: string | undefined;
  statusMessage?: string;
  isLoading: boolean;
  onSuggestionClick?: (text: string) => void;
  onRetry?: (assistantIndex: number) => void;
  onFork?: (messageIndex: number) => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenFileChanges?: (changeSet: FileChangeSet) => void;
  onUndoFileChanges?: (changeSet: FileChangeSet) => void;
  onOpenMemories?: () => void;
  baseUrl: string;
  token: string | null;
}

const SUGGESTIONS: {
  title: string;
  description: string;
  prompt: string;
  icon: LucideIcon;
}[] = [
  {
    title: "Summarize workspace",
    description: "Get an overview of the files in your project",
    prompt: "Summarize the files in my workspace",
    icon: FileText,
  },
  {
    title: "Visualize data",
    description: "Create charts and plots from your datasets",
    prompt: "Create a chart from my data",
    icon: BarChart3,
  },
  {
    title: "Explore a dataset",
    description: "Investigate patterns, stats, and outliers",
    prompt: "Help me explore a dataset",
    icon: Compass,
  },
];

export function WelcomeContent() {
  return (
    <div className="w-full text-center">
      <h1 className="font-display text-[clamp(1.85rem,3.2vw,2.35rem)] text-scout-text">
        What are we working on?
      </h1>
    </div>
  );
}

export function SuggestionChips({
  onSuggestionClick,
}: {
  onSuggestionClick: (text: string) => void;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-3">
      {SUGGESTIONS.map((s) => {
        const Icon = s.icon;
        return (
          <button
            key={s.prompt}
            onClick={() => onSuggestionClick(s.prompt)}
            title={s.description}
            className="group flex items-start gap-2.5 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-scout-panel/70"
          >
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-scout-muted/80 group-hover:text-scout-text">
              <Icon size={15} strokeWidth={1.8} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-scout-text/90">{s.title}</span>
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
  onRetry,
  onFork,
  onOpenArtifact,
  onOpenFileChanges,
  onUndoFileChanges,
  onOpenMemories,
  baseUrl,
  token,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTool =
    currentTool ?? streamingSteps.find((step) => step.status === "executing")?.name;

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streamingSteps, streamingText, isLoading]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[46rem] mx-auto px-4 py-8 space-y-7">
        {messages.map((msg, i) => {
          const hasTimeline = msg.role === "assistant" && !!msg.steps?.length;
          const timelineHasText = !!msg.steps?.some((step) => step.kind === "text");
          // When mid-turn prose is already in the timeline, only show final
          // content if it is not a duplicate of the last text block.
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
            || !!msg.artifacts?.length
            || !!msg.fileChanges?.length;

          return (
            <div key={i}>
              {/* Interleaved thinking / tools / mid-turn prose in event order. */}
              {hasTimeline && (
                <ToolCard
                  steps={msg.steps!}
                  baseUrl={baseUrl}
                  token={token}
                />
              )}
              {showBubble && (
                <MessageBubble
                  message={
                    contentAlreadyInTimeline
                      ? { ...msg, content: "" }
                      : msg
                  }
                  onRetry={msg.role === "assistant" && onRetry ? () => onRetry(i) : undefined}
                  onFork={onFork ? () => onFork(i) : undefined}
                  onOpenArtifact={onOpenArtifact}
                  onOpenFileChanges={onOpenFileChanges}
                  onUndoFileChanges={onUndoFileChanges}
                  onOpenMemories={onOpenMemories}
                  baseUrl={baseUrl}
                  token={token}
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
              />
            )}
            {streamingText ? (
              <div className="prose-scout text-[15px]">
                <MessageBubble
                  message={{ role: "assistant", content: streamingText }}
                  baseUrl={baseUrl}
                  token={token}
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
