import { useRef, useEffect } from "react";
import { FileText, BarChart3, Compass, type LucideIcon } from "lucide-react";
import type { Message, ToolStep } from "scout-core";
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
  onOpenMemories?: () => void;
  baseUrl: string;
  token: string | null;
}

const SUGGESTIONS: {
  title: string;
  description: string;
  prompt: string;
  tint: "lavender" | "peach" | "amber";
  icon: LucideIcon;
}[] = [
  {
    title: "Summarize workspace",
    description: "Get an overview of the files in your project",
    prompt: "Summarize the files in my workspace",
    tint: "lavender",
    icon: FileText,
  },
  {
    title: "Visualize data",
    description: "Create charts and plots from your datasets",
    prompt: "Create a chart from my data",
    tint: "peach",
    icon: BarChart3,
  },
  {
    title: "Explore a dataset",
    description: "Investigate patterns, stats, and outliers",
    prompt: "Help me explore a dataset",
    tint: "amber",
    icon: Compass,
  },
];

// Pika-style tints — theme-aware tokens, dark text in light / light text in dark.
const tintClasses = {
  lavender: "bg-scout-card-lavender hover:bg-scout-card-lavender-hover",
  peach: "bg-scout-card-peach hover:bg-scout-card-peach-hover",
  amber: "bg-scout-card-amber hover:bg-scout-card-amber-hover",
};

export function WelcomeContent() {
  return (
    <div className="w-full">
      <h1 className="font-display text-display text-scout-text mb-5 text-center uppercase">
        Explore your data
      </h1>
      <p className="text-body font-medium text-scout-text/80 max-w-md mx-auto text-center leading-relaxed">
      Scout helps you analyze data, write code, and create charts, reports, and more.
      </p>
    </div>
  );
}

export function SuggestionChips({
  onSuggestionClick,
}: {
  onSuggestionClick: (text: string) => void;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {SUGGESTIONS.map((s) => {
        const Icon = s.icon;
        return (
          <button
            key={s.prompt}
            onClick={() => onSuggestionClick(s.prompt)}
            title={s.description}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-pill text-[13px] font-medium text-scout-text transition-all duration-150 hover:-translate-y-0.5 hover:shadow-card-hover active:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${tintClasses[s.tint]}`}
          >
            <Icon size={15} strokeWidth={2} className="text-scout-text/70" />
            {s.title}
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
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-8">
        {messages.map((msg, i) => (
          <div key={i}>
            {/* Tool steps happen before the reply is written — show them in
                that order so the transcript reads chronologically. */}
            {msg.role === "assistant" && msg.steps && msg.steps.length > 0 && (
              <ToolCard steps={msg.steps} />
            )}
            <MessageBubble
              message={msg}
              onRetry={msg.role === "assistant" && onRetry ? () => onRetry(i) : undefined}
              onFork={onFork ? () => onFork(i) : undefined}
              onOpenArtifact={onOpenArtifact}
              onOpenMemories={onOpenMemories}
              baseUrl={baseUrl}
              token={token}
            />
          </div>
        ))}

        {isLoading && (
          <div>
            {streamingSteps.length > 0 && (
              <ToolCard steps={streamingSteps} defaultExpanded />
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
