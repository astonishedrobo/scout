import { useState, useCallback } from "react";
import type { Message, ResponseAnnotation } from "scout-core";
import { AssistantProse } from "./AssistantProse";
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
  /** Text the copy action should write. Defaults to `message.content`; pass it
   *  explicitly when the visible prose lives somewhere other than `content`. */
  copyText?: string;
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
  copyText,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const hasMemoryUpdate = message.steps?.some(
    (step) =>
      step.name === "memory_add_note" &&
      step.status === "complete" &&
      !/no memory written/i.test(step.output ?? ""),
  );

  // `copyText` exists because ChatView blanks `content` when the prose was
  // already rendered by the timeline — copying `message.content` then produced
  // an empty clipboard for the most common kind of turn.
  const textToCopy = copyText ?? message.content;

  const handleCopy = useCallback(async () => {
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard unavailable (insecure origin / denied permission). */
    }
  }, [textToCopy]);

  if (message.role === "user") {
    const additionalRequest = message.annotations?.length
      ? message.content.split("\n\nAdditional request:\n")[1]?.trim()
      : message.content;
    return (
      <div className="flex justify-end group w-full">
        <div className="flex max-w-[min(75%,34rem)] flex-col items-end">
          {/* Attachments stack above the bubble — cards are
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
          <div className="w-fit max-w-full rounded-message bg-scout-input-bg/80 px-3.5 py-2">
            {!!message.annotations?.length && (
              <div className="mb-2.5 rounded-control bg-scout-panel/55 px-2.5 py-2">
                <p className="text-caption font-semibold text-scout-text">{message.annotations.length} annotation{message.annotations.length === 1 ? "" : "s"}</p>
                <div className="mt-1.5 space-y-1.5">
                  {message.annotations.map((annotation, index) => (
                    <div key={annotation.id} className="text-caption leading-snug text-scout-muted">
                      <span className="mr-1 font-semibold text-scout-text">{index + 1}.</span>
                      <span>“{annotation.quote}”</span>
                      {annotation.comment.trim() && <span className="text-scout-text"> — {annotation.comment}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-scout-text text-prose leading-relaxed whitespace-pre-wrap break-words">
              {additionalRequest || (message.annotations?.length ? "Please address these notes." : message.content)}
            </p>
          </div>
          <div className="mt-1 flex justify-end">
            <button
              onClick={handleCopy}
            className="hover-reveal p-2 rounded-btn text-scout-muted hover:text-scout-text
                       hover:bg-scout-lift/80"
              title="Copy message"
              aria-label="Copy message"
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
        <div className="mb-2 inline-flex items-center rounded-btn border border-scout-hairline-faint bg-scout-panel/60 px-2 py-0.5 text-micro font-medium text-scout-muted">
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
              <AssistantProse content={message.content} baseUrl={baseUrl} token={token} />
            </AnnotationRegion>
          ) : (
            <AssistantProse content={message.content} baseUrl={baseUrl} token={token} />
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

      <div className="group mt-2 -ml-1 flex items-center gap-0.5">
        <button
          onClick={handleCopy}
          className="hover-reveal rounded-btn p-2 text-scout-muted hover:bg-scout-lift/80 hover:text-scout-text"
          title="Copy response"
          aria-label="Copy response"
          disabled={!textToCopy}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            className="hover-reveal rounded-btn p-2 text-scout-muted hover:bg-scout-lift/80 hover:text-scout-text"
            title="Retry"
            aria-label="Retry this response"
          >
            <RotateCcw size={16} />
          </button>
        )}
        {onFork && (
          <button
            onClick={onFork}
            className="hover-reveal rounded-btn p-2 text-scout-muted hover:bg-scout-lift/80 hover:text-scout-text"
            title="Fork from here"
            aria-label="Fork the conversation from here"
          >
            <GitBranch size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
