import { useState, useCallback } from "react";
import type { Message } from "scout-core";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { Copy, Check, RotateCcw, GitBranch } from "lucide-react";
import type { Artifact } from "scout-core";
import { ArtifactCards } from "./ArtifactCards";
import { AuthenticatedImage } from "./AuthenticatedImage";
import { MemoryUpdateChip } from "./MemoryUpdateChip";

interface MessageBubbleProps {
  message: Message;
  onRetry?: () => void;
  onFork?: () => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenMemories?: () => void;
  baseUrl?: string;
  token?: string | null;
}

export function MessageBubble({ message, onRetry, onFork, onOpenArtifact, onOpenMemories, baseUrl = "", token = null }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const hasMemoryUpdate = message.steps?.some(
    (step) =>
      step.name === "memory_add_note" &&
      step.status === "complete" &&
      !/no memory written/i.test(step.output ?? ""),
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message.content]);

  if (message.role === "user") {
    return (
      <div className="flex justify-end group w-full">
        <div className="max-w-[min(75%,34rem)]">
          <div className="bg-scout-input-bg/90 border border-scout-hairline-faint rounded-2xl px-4 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            {!!message.chatImages?.length && (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {message.chatImages.map((image) => (
                  <AuthenticatedImage key={image.id} src={`${baseUrl}${image.url}`} token={token} alt={image.name} className="h-28 max-w-48 rounded-btn object-cover border border-scout-hairline-faint" />
                ))}
              </div>
            )}
            {message.attachments?.some((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)) && (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {message.attachments.filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)).map((path) => (
                  <AuthenticatedImage key={path} src={`${baseUrl}/files/content?path=${encodeURIComponent(path)}`} token={token} alt={path.split("/").pop() ?? path} className="h-28 max-w-48 rounded-btn object-cover border border-scout-hairline-faint" />
                ))}
              </div>
            )}
            <p className="text-scout-text text-[15px] leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </p>
          </div>
          <div className="mt-1 flex justify-end">
            <button
              onClick={handleCopy}
            className="hover-reveal p-2 rounded-btn text-scout-muted hover:text-scout-text
                       hover:bg-scout-lift/80"
              title="Copy message"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="min-w-0 overflow-hidden">
        <div className="prose-scout text-[15px] overflow-x-auto">
          <MarkdownRenderer content={message.content} baseUrl={baseUrl} token={token} />
        </div>
      </div>
      {message.artifacts && message.artifacts.length > 0 && onOpenArtifact && (
        <ArtifactCards
          artifacts={message.artifacts}
          onOpen={onOpenArtifact}
          onOpenMemories={onOpenMemories}
          baseUrl={baseUrl}
          token={token}
        />
      )}
      {hasMemoryUpdate && <MemoryUpdateChip onOpenMemories={onOpenMemories} className="mt-3" />}

      <div className="flex items-center gap-0.5 mt-2 -ml-1">
        <button
          onClick={handleCopy}
          className="p-2 rounded-btn text-scout-muted hover:text-scout-text
                     hover:bg-scout-lift/80 transition-colors"
          title="Copy response"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            className="p-2 rounded-btn text-scout-muted hover:text-scout-text
                       hover:bg-scout-lift/80 transition-colors"
            title="Retry"
          >
            <RotateCcw size={16} />
          </button>
        )}
        {onFork && (
          <button
            onClick={onFork}
            className="p-2 rounded-btn text-scout-muted hover:text-scout-text
                       hover:bg-scout-lift/80 transition-colors"
            title="Fork from here"
          >
            <GitBranch size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
