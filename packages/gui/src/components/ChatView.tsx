import { useRef, useEffect } from "react";
import type { Message, ToolStep } from "scout-core";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";
import { StreamingIndicator } from "./StreamingIndicator";
import { Sparkles } from "lucide-react";

interface ChatViewProps {
  messages: Message[];
  streamingSteps: ToolStep[];
  streamingText: string;
  currentTool: string | undefined;
  isLoading: boolean;
  onSuggestionClick?: (text: string) => void;
  onRetry?: (assistantIndex: number) => void;
}

export function WelcomeContent() {
  return (
    <div className="text-center">
      <Sparkles size={28} className="text-scout-accent mx-auto mb-4 opacity-40" />
      <h2 className="text-2xl font-semibold text-scout-text-primary mb-8">
        How can I help you?
      </h2>
    </div>
  );
}

export function ChatView({
  messages,
  streamingSteps,
  streamingText,
  currentTool,
  isLoading,
  onRetry,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streamingSteps, streamingText, isLoading]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === "assistant" && msg.steps && msg.steps.length > 0 && (
              <ToolCard steps={msg.steps} />
            )}
            <MessageBubble
              message={msg}
              onRetry={msg.role === "assistant" && onRetry ? () => onRetry(i) : undefined}
            />
          </div>
        ))}

        {isLoading && (
          <div>
            {streamingSteps.length > 0 && (
              <ToolCard steps={streamingSteps} defaultExpanded />
            )}
            <StreamingIndicator currentTool={currentTool} text={streamingText} />
          </div>
        )}
      </div>
    </div>
  );
}
