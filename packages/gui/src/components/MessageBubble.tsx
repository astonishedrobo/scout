import { useState, useCallback } from "react";
import type { Message, ResponseAnnotation } from "scout-core";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { Copy, Check, RotateCcw, GitBranch } from "lucide-react";
import type { Artifact, FileChangeSet } from "scout-core";
import { ArtifactCards } from "./ArtifactCards";
import { MemoryUpdateChip } from "./MemoryUpdateChip";
import { FileChangeCards } from "./FileChangeCards";
import { AnnotationRegion } from "./AnnotationRegion";
import { AttachmentCard } from "./AttachmentCard";

interface MessageBubbleProps {
  message: Message;
  onRetry?: () => void;
  onFork?: () => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenFileChanges?: (changeSet: FileChangeSet) => void;
  onUndoFileChanges?: (changeSet: FileChangeSet) => void;
  onOpenMemories?: () => void;
  baseUrl?: string;
  token?: string | null;
  sourceId?: string;
  annotations?: ResponseAnnotation[];
  annotationNumbers?: Map<string, number>;
  onAddAnnotation?: (annotation: Omit<ResponseAnnotation, "id" | "createdAt" | "updatedAt">) => void;
  onUpdateAnnotation?: (id: string, changes: Pick<ResponseAnnotation, "comment">) => void;
  onRemoveAnnotation?: (id: string) => void;
}

export function MessageBubble({
  message,
  onRetry,
  onFork,
  onOpenArtifact,
  onOpenFileChanges,
  onUndoFileChanges,
  onOpenMemories,
  baseUrl = "",
  token = null,
  sourceId,
  annotations = [],
  annotationNumbers = new Map(),
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: MessageBubbleProps) {
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
    const additionalRequest = message.annotations?.length
      ? message.content.split("\n\nAdditional request:\n")[1]?.trim()
      : message.content;
    return (
      <div className="flex justify-end group w-full">
        <div className="flex max-w-[min(75%,34rem)] flex-col items-end">
          {/* Attachments stack above the bubble, ChatGPT-style — cards are
              siblings of the message, not wrapped inside it. */}
          {(!!message.chatImages?.length || !!message.attachments?.length) && (
            <div className="mb-1.5 flex flex-col items-end gap-1.5">
              {message.chatImages?.map((image) => (
                <AttachmentCard key={image.id} path={image.name} name={image.name} size={image.size} baseUrl={baseUrl} token={token} previewUrl={`${baseUrl}${image.url}`} />
              ))}
              {message.attachments?.map((path) => (
                <AttachmentCard key={path} path={path} baseUrl={baseUrl} token={token} />
              ))}
            </div>
          )}
          <div className="w-fit max-w-full rounded-card border border-scout-hairline-faint bg-scout-input-bg px-4 py-2.5">
            {!!message.annotations?.length && (
              <div className="mb-2.5 rounded-btn border border-scout-hairline-faint bg-scout-panel/70 p-2.5">
                <p className="text-xs font-semibold text-scout-text">{message.annotations.length} annotation{message.annotations.length === 1 ? "" : "s"}</p>
                <div className="mt-1.5 space-y-1.5">
                  {message.annotations.map((annotation, index) => (
                    <div key={annotation.id} className="text-xs leading-snug text-scout-muted">
                      <span className="mr-1 font-semibold text-scout-text">{index + 1}.</span>
                      <span>“{annotation.quote}”</span>
                      {annotation.comment.trim() && <span className="text-scout-text"> — {annotation.comment}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-scout-text text-[15px] leading-relaxed whitespace-pre-wrap break-words">
              {additionalRequest || (message.annotations?.length ? "Please address these notes." : message.content)}
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
    <div className="group/assistant">
      {message.stopped && (
        <div className="mb-2 inline-flex items-center rounded-btn border border-scout-hairline-faint bg-scout-panel/60 px-2 py-0.5 text-[11px] font-medium text-scout-muted">
          Stopped
        </div>
      )}
      {!!message.content?.trim() && (
        <div className="min-w-0 overflow-hidden">
          {sourceId && onAddAnnotation && onUpdateAnnotation && onRemoveAnnotation ? (
            <AnnotationRegion
              sourceId={sourceId}
              annotations={annotations}
              annotationNumbers={annotationNumbers}
              onAdd={onAddAnnotation}
              onUpdate={onUpdateAnnotation}
              onRemove={onRemoveAnnotation}
            >
              <div className="prose-scout text-[15px] overflow-x-auto">
                <MarkdownRenderer content={message.content} baseUrl={baseUrl} token={token} />
              </div>
            </AnnotationRegion>
          ) : (
            <div className="prose-scout text-[15px] overflow-x-auto">
              <MarkdownRenderer content={message.content} baseUrl={baseUrl} token={token} />
            </div>
          )}
        </div>
      )}
      {message.artifacts && message.artifacts.length > 0 && onOpenArtifact && (
        <ArtifactCards
          artifacts={message.artifacts}
          onOpen={onOpenArtifact}
          onOpenMemories={onOpenMemories}
          baseUrl={baseUrl}
          token={token}
        />
      )}
      {message.fileChanges && message.fileChanges.length > 0 && onOpenFileChanges && onUndoFileChanges && (
        <FileChangeCards
          changeSets={message.fileChanges}
          onReview={onOpenFileChanges}
          onUndo={onUndoFileChanges}
        />
      )}
      {hasMemoryUpdate && <MemoryUpdateChip onOpenMemories={onOpenMemories} className="mt-3" />}

      <div className="flex items-center gap-0.5 mt-2 -ml-1 opacity-0 group-hover/assistant:opacity-100 focus-within:opacity-100 transition-opacity">
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
