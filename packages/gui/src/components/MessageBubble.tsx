import { useState, useCallback } from "react";
import type { Message } from "scout-core";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { Copy, Check, RotateCcw } from "lucide-react";

interface MessageBubbleProps {
  message: Message;
  onRetry?: () => void;
}

export function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);

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
          <div className="bg-[#141413] rounded-xl px-4 py-2.5">
            <p className="text-scout-text-primary text-sm whitespace-pre-wrap break-words">
              {message.content}
            </p>
          </div>
          <div className="mt-1 flex justify-end">
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg text-scout-text-secondary/40 hover:text-scout-text-primary
                       hover:bg-scout-surface-hover transition-all
                       opacity-0 group-hover:opacity-100"
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
        <div className="prose-scout text-sm overflow-x-auto">
          <MarkdownRenderer content={message.content} />
        </div>
      </div>

      {/* Action buttons - always visible */}
      <div className="flex items-center gap-0.5 mt-2">
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-lg text-scout-text-secondary/50 hover:text-scout-text-primary
                     hover:bg-scout-surface-hover transition-colors"
          title="Copy response"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            className="p-1.5 rounded-lg text-scout-text-secondary/50 hover:text-scout-text-primary
                       hover:bg-scout-surface-hover transition-colors"
            title="Retry"
          >
            <RotateCcw size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
