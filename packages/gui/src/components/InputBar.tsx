import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import {
  ArrowUp,
  Plus,
  AtSign,
  FileText,
  Command,
  ChevronDown,
  Square,
  Loader2,
  Upload,
  Check,
  X,
  Camera,
  AlertTriangle,
  Hand,
  ShieldCheck,
  ShieldAlert,
  MessageSquare,
  CornerDownRight,
  Trash2,
} from "lucide-react";
import { AnchoredPopover } from "./ui/AnchoredPopover";
import type { ApprovalMode, ChatImage, ResponseAnnotation } from "scout-core";
import type { UploadResult } from "../hooks/useUploads";
import { formatAnnotatedFollowUp } from "../hooks/useResponseAnnotations";
import { AttachmentCard, isImageAttachment } from "./AttachmentCard";

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/reset", description: "Clear conversation and start fresh" },
  { name: "/init", description: "Generate workspace skills" },
  { name: "/model", description: "Switch active model" },
  { name: "/settings", description: "Open settings panel" },
  { name: "/help", description: "Show help" },
];

interface FileEntry {
  path: string;
  abs_path: string;
  scope: "workspace" | "personal" | "shared";
}

interface InputBarProps {
  baseUrl: string;
  onSubmit: (text: string, attachments?: string[], chatImages?: ChatImage[], onAccepted?: () => void, annotations?: ResponseAnnotation[]) => Promise<boolean>;
  onSlashCommand?: (command: string) => void;
  disabled: boolean;
  isLoading?: boolean;
  onStop?: () => void;
  models: string[];
  capabilities: Record<string, { vision: "supported" | "unsupported" | "unverified" }>;
  currentModel: string;
  onSelectModel: (model: string) => void;
  approvalMode: ApprovalMode;
  onSelectApprovalMode: (mode: ApprovalMode) => Promise<void> | void;
  approvalModeChanging?: boolean;
  modelDisabled?: boolean;
  pendingSteers?: Array<{
    steerId: string;
    content: string;
    status: "sending" | "pending" | "steering";
  }>;
  onActivateSteer?: (steerId: string) => void;
  onCancelSteer?: (steerId: string) => void;
  isMultiUser?: boolean;
  token?: string | null;
  uploadingCount?: number;
  /** Workspace upload. When used from the chat plus menu, successful results
   *  are also inserted as @file references at the cursor. */
  onUpload?: (files: FileList | null) => void | Promise<UploadResult[] | void>;
  welcomeMode?: boolean;
  embedded?: boolean;
  requiresVision?: boolean;
  ensureSession: () => Promise<string>;
  annotations?: ResponseAnnotation[];
  onUpdateAnnotation?: (id: string, changes: Pick<ResponseAnnotation, "comment">) => void;
  onRemoveAnnotation?: (id: string) => void;
}

export function InputBar({
  baseUrl,
  onSubmit,
  onSlashCommand,
  disabled,
  isLoading,
  onStop,
  models,
  capabilities,
  currentModel,
  onSelectModel,
  approvalMode,
  onSelectApprovalMode,
  approvalModeChanging = false,
  modelDisabled = false,
  pendingSteers = [],
  onActivateSteer,
  onCancelSteer,
  token,
  uploadingCount = 0,
  onUpload,
  welcomeMode = false,
  embedded = false,
  requiresVision = false,
  ensureSession,
  annotations = [],
  onUpdateAnnotation,
  onRemoveAnnotation,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const approvalBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [showAt, setShowAt] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atFiles, setAtFiles] = useState<FileEntry[]>([]);
  const [atPrefix, setAtPrefix] = useState("");
  const [atStartPos, setAtStartPos] = useState(0);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [fileAttachments, setFileAttachments] = useState<UploadResult[]>([]);
  const [chatImages, setChatImages] = useState<ChatImage[]>([]);
  const [pastingImages, setPastingImages] = useState(false);
  const [showAnnotationReview, setShowAnnotationReview] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [annotationComment, setAnnotationComment] = useState("");

  const fetchIdRef = useRef(0);
  const cursorPosRef = useRef(0);

  const slashFilter = value.startsWith("/") ? value.toLowerCase() : "";
  const filteredCommands = slashFilter
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashFilter))
    : SLASH_COMMANDS;

  const updateCursorPos = useCallback(() => {
    cursorPosRef.current = textareaRef.current?.selectionStart ?? value.length;
  }, [value]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.addEventListener("select", updateCursorPos);
    ta.addEventListener("click", updateCursorPos);
    ta.addEventListener("keyup", updateCursorPos);
    return () => {
      ta.removeEventListener("select", updateCursorPos);
      ta.removeEventListener("click", updateCursorPos);
      ta.removeEventListener("keyup", updateCursorPos);
    };
  }, [updateCursorPos]);

  useEffect(() => {
    if (value.startsWith("/") && !value.includes(" ")) {
      setShowSlash(true);
      setSlashIndex(0);
    } else {
      setShowSlash(false);
    }
  }, [value]);

  useEffect(() => {
    const pos = cursorPosRef.current || value.length;
    const before = value.slice(0, pos);
    const atMatch = before.match(/(^|[\s])@([^\s]*)$/);

    if (atMatch) {
      const prefix = atMatch[2];
      setAtPrefix(prefix);
      setAtStartPos(before.length - atMatch[0].length + atMatch[1].length);
      setShowAt(true);
      setAtIndex(0);

      const timer = setTimeout(() => {
        const id = ++fetchIdRef.current;
        fetch(`${baseUrl}/files?prefix=${encodeURIComponent(prefix)}&limit=20`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
          .then((r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.json();
          })
          .then((data) => {
            if (fetchIdRef.current === id) {
              const raw = data.files ?? [];
              const entries: FileEntry[] = raw.map((f: FileEntry | string) =>
                typeof f === "string" ? { path: f, abs_path: f, scope: "workspace" } : f,
              );
              setAtFiles(entries);
            }
          })
          .catch(() => {
            if (fetchIdRef.current === id) setAtFiles([]);
          });
      }, 200);
      return () => clearTimeout(timer);
    } else {
      setShowAt(false);
      setAtFiles([]);
    }
  }, [value, baseUrl, token]);

  const minH = welcomeMode ? 76 : 44;
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Grow naturally until roughly 30% of the viewport, with a comfortable
    // desktop ceiling. Once capped, keep the prompt internally scrollable.
    const viewportCap = Math.round(window.innerHeight * (welcomeMode ? 0.32 : 0.30));
    const maxH = Math.min(240, Math.max(120, viewportCap));
    ta.style.height = "auto";
    const nextHeight = Math.max(Math.min(ta.scrollHeight, maxH), minH);
    ta.style.height = `${nextHeight}px`;
    const capped = ta.scrollHeight > maxH;
    ta.style.overflowY = capped ? "auto" : "hidden";
    // Browsers retain a stale scroll offset after shrinking/growing a textarea,
    // which can hide its first line after the first newline.
    if (!capped) ta.scrollTop = 0;
  }, [minH, welcomeMode]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [value, resizeTextarea]);

  useEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);

  const acceptSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      setShowSlash(false);
      setValue("");
      onSlashCommand?.(cmd.name);
    },
    [onSlashCommand],
  );

  const acceptFileRef = useCallback(
    (file: FileEntry) => {
      // The picked file becomes an attachment card (same as uploads); the
      // typed "@prefix" token is removed from the draft — no raw paths.
      const before = value.slice(0, atStartPos);
      const after = value.slice(atStartPos + 1 + atPrefix.length);
      const newPos = before.length;
      cursorPosRef.current = newPos;
      setValue(before + after);
      const attachment: UploadResult = { filename: file.path.split("/").pop() || file.path, path: file.path, abs_path: file.abs_path, scope: file.scope, size: 0 };
      setFileAttachments((prev) => prev.some((item) => item.abs_path === file.abs_path) ? prev : [...prev, attachment]);
      setShowAt(false);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newPos, newPos);
        }
      }, 0);
    },
    [value, atStartPos, atPrefix],
  );

  /** Keep uploaded paths as attachment metadata; never expose them in prompt text. */
  const addUploadedFiles = useCallback((results: UploadResult[]) => {
    if (results.length === 0) return;
    setFileAttachments((current) => {
      const next = [...current];
      results.forEach((result) => {
        if (!next.some((item) => item.abs_path === result.abs_path)) next.push(result);
      });
      return next;
    });

    setTimeout(() => {
      const el = textareaRef.current;
      el?.focus();
    }, 0);
  }, []);

  const handleChatUpload = useCallback(
    async (files: FileList | null) => {
      if (!files?.length || !onUpload) return;
      const maybe = onUpload(files);
      const results = maybe && typeof (maybe as Promise<unknown>).then === "function"
        ? await (maybe as Promise<UploadResult[] | void>)
        : undefined;
      if (Array.isArray(results) && results.length > 0) {
        addUploadedFiles(results);
      }
    },
    [onUpload, addUploadedFiles],
  );

  const insertAtSymbol = useCallback(() => {
    setShowPlusMenu(false);
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const needsSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
    const insert = (needsSpace ? " " : "") + "@";
    setValue(before + insert + after);
    const newPos = pos + insert.length;
    cursorPosRef.current = newPos;
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(newPos, newPos);
    }, 0);
  }, [value]);

  const insertSlash = useCallback(() => {
    setShowPlusMenu(false);
    setValue("/");
    cursorPosRef.current = 1;
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(1, 1);
      }
    }, 0);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if ((!trimmed && fileAttachments.length === 0 && chatImages.length === 0 && annotations.length === 0) || disabled) return;
    if ((fileAttachments.some((file) => isImageAttachment(file.filename || file.path)) || chatImages.length > 0) && capabilities[currentModel]?.vision !== "supported") return;

    if (showSlash && filteredCommands.length > 0) {
      acceptSlashCommand(filteredCommands[slashIndex]!);
      return;
    }

    if (showAt && atFiles.length > 0) {
      acceptFileRef(atFiles[atIndex]!);
      return;
    }

    if (trimmed.startsWith("/")) {
      const match = SLASH_COMMANDS.find((c) => c.name === trimmed);
      if (match) {
        setValue("");
        onSlashCommand?.(match.name);
        return;
      }
    }

    // Clear the draft immediately — the chat shows the message optimistically,
    // so text lingering in the composer would read as a duplicate. Restore the
    // draft if the server rejects the send.
    const draftValue = value;
    const draftAttachments = fileAttachments;
    const draftImages = chatImages;
    setValue("");
    setFileAttachments([]);
    setChatImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // Collect @paths from the draft so non-image uploads (CSV, PDF, …) become
    // real attachments, not only bare text tokens.
    const atPaths = [...trimmed.matchAll(/@((?:\.{0,2}\/)?[^\s,;'"]+)/g)]
      .map((m) => m[1]!)
      .filter(Boolean);
    const attachmentSet = new Set<string>([
      ...draftAttachments.map((attachment) => attachment.abs_path),
      ...atPaths,
    ]);
    const accepted = await onSubmit(
      annotations.length ? formatAnnotatedFollowUp(annotations, trimmed) : trimmed,
      [...attachmentSet],
      draftImages,
      undefined,
      annotations,
    );
    if (!accepted) {
      setValue(draftValue);
      setFileAttachments(draftAttachments);
      setChatImages(draftImages);
    }
  }, [
    value,
    disabled,
    onSubmit,
    onSlashCommand,
    showSlash,
    filteredCommands,
    slashIndex,
    acceptSlashCommand,
    showAt,
    atFiles,
    atIndex,
    acceptFileRef,
    fileAttachments,
    capabilities,
    currentModel,
    chatImages,
    annotations,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlash && filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          acceptSlashCommand(filteredCommands[slashIndex]!);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSlash(false);
          return;
        }
      }

      if (showAt && atFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtIndex((i) => Math.min(i + 1, atFiles.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          acceptFileRef(atFiles[atIndex]!);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowAt(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [
      handleSubmit,
      showSlash,
      filteredCommands,
      slashIndex,
      acceptSlashCommand,
      showAt,
      atFiles,
      atIndex,
      acceptFileRef,
    ],
  );

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length === 0) return;
    e.preventDefault();
    setPastingImages(true);
    try {
      const sessionId = await ensureSession();
      const uploaded: ChatImage[] = [];
      for (const [index, file] of files.entries()) {
        const form = new FormData();
        form.append("file", file, file.name || `pasted-image-${index + 1}.png`);
        const resp = await fetch(`${baseUrl}/sessions/${sessionId}/chat-images`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: form,
        });
        if (!resp.ok) throw new Error(await resp.text());
        uploaded.push(await resp.json() as ChatImage);
      }
      setChatImages((prev) => [...prev, ...uploaded]);
    } finally {
      setPastingImages(false);
    }
  }, [baseUrl, token, ensureSession]);

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const hasText = value.trim().length > 0;
  const hasImageAttachment = fileAttachments.some((file) => isImageAttachment(file.filename || file.path));
  const visionBlocked = (hasImageAttachment || chatImages.length > 0) && capabilities[currentModel]?.vision !== "supported";
  const shortModel = currentModel ? (currentModel.split("/").pop() ?? currentModel) : "No model";

  const popoverMenuItem =
    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium hover:bg-scout-lift/80 transition-colors text-left";

  const sendBtnClass = "flex h-9 w-9 items-center justify-center rounded-full flex-shrink-0 transition-all";
  const approvalLabel = approvalMode === "ask_always"
    ? "Ask every time"
    : approvalMode === "allow_edits"
      ? "Allow edits"
      : "Full access";
  const ApprovalIcon = approvalMode === "ask_always"
    ? Hand
    : approvalMode === "allow_edits"
      ? ShieldCheck
      : ShieldAlert;

  return (
    <div
      ref={containerRef}
      className={`relative w-full shrink-0 ${
        embedded ? "" : "max-w-[46rem] mx-auto px-4 bg-scout-canvas/95 py-3"
      } ${welcomeMode && !embedded ? "pt-4 pb-6" : ""}`}
    >
      {uploadingCount > 0 && (
        <div className="flex items-center gap-1.5 px-1 pb-2 text-xs text-scout-muted">
          <Loader2 size={12} className="animate-spin" />
          <span>
            {uploadingCount} file{uploadingCount > 1 ? "s" : ""} still uploading
          </span>
        </div>
      )}

      {pendingSteers.length > 0 && (
        <div className="relative z-10 mx-3 -mb-px overflow-hidden rounded-t-[14px] border border-b-0 border-scout-hairline-faint bg-scout-lift/90">
          {pendingSteers.map((steer, index) => (
            <div
              key={steer.steerId}
              className={`flex min-h-9 items-center gap-2 px-3 py-1.5 text-[12px] ${
                index > 0 ? "border-t border-scout-hairline-faint" : ""
              }`}
            >
              <CornerDownRight size={12} className="shrink-0 text-scout-muted/80" />
              <span className="min-w-0 flex-1 truncate text-scout-text">
                {steer.content || "Attachment"}
              </span>
              {steer.status === "pending" ? (
                <button
                  type="button"
                  onClick={() => onActivateSteer?.(steer.steerId)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-medium text-scout-muted transition-colors hover:bg-scout-panel/70 hover:text-scout-text"
                  aria-label="Steer current turn with this message"
                >
                  <CornerDownRight size={12} />
                  Steer
                </button>
              ) : (
                <span className="flex shrink-0 items-center gap-1.5 font-medium text-scout-muted">
                  <Loader2 size={11} className="animate-spin" />
                  {steer.status === "sending" ? "Queuing…" : "Steering…"}
                </span>
              )}
              {steer.status === "pending" && (
                <button
                  type="button"
                  onClick={() => onCancelSteer?.(steer.steerId)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-scout-muted transition-colors hover:bg-scout-panel/70 hover:text-scout-text"
                  aria-label="Cancel steer"
                  title="Cancel steer"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div
      className={`relative flex flex-col overflow-visible rounded-[26px] border border-scout-hairline-faint bg-scout-panel shadow-composer transition-all focus-within:border-scout-hairline focus-within:ring-1 focus-within:ring-scout-text/10 ${disabled ? "opacity-60" : ""}`}
      >
        {showAnnotationReview && annotations.length > 0 && (
          <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-40 rounded-card border border-scout-hairline bg-scout-panel p-3 shadow-pop">
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {annotations.map((annotation, index) => (
                <div key={annotation.id} className="rounded-btn p-2 hover:bg-scout-lift/40">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-[13px] font-medium text-scout-muted">{index + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-scout-muted">Selected text:</p>
                      <button type="button" onClick={() => { setEditingAnnotationId(annotation.id); setAnnotationComment(annotation.comment); }} className="mt-0.5 block w-full text-left text-[13px] leading-snug text-scout-text hover:underline">{annotation.quote}</button>
                    </div>
                    <button type="button" onClick={() => onRemoveAnnotation?.(annotation.id)} className="rounded p-1 text-scout-error/80 hover:bg-scout-error-muted hover:text-scout-error" aria-label={`Remove annotation ${index + 1}`}><Trash2 size={13} /></button>
                  </div>
                  {editingAnnotationId === annotation.id ? (
                    <div className="mt-2 pl-5">
                      <textarea value={annotationComment} onChange={(event) => setAnnotationComment(event.target.value)} rows={2} placeholder="Add an optional comment…" className="w-full resize-none rounded-btn border border-scout-hairline-faint bg-scout-panel px-2 py-1.5 text-xs text-scout-text outline-none" />
                      <div className="mt-1.5 flex justify-end gap-1.5"><button type="button" onClick={() => setEditingAnnotationId(null)} className="rounded-btn px-2 py-1 text-xs text-scout-muted hover:bg-scout-lift">Cancel</button><button type="button" onClick={() => { onUpdateAnnotation?.(annotation.id, { comment: annotationComment }); setEditingAnnotationId(null); }} className="rounded-btn bg-scout-text px-2 py-1 text-xs font-semibold text-scout-bg">Save</button></div>
                    </div>
                  ) : annotation.comment.trim() ? (
                    <div className="mt-1.5 pl-6">
                      <p className="text-xs font-medium text-scout-muted">User comment:</p>
                      <p className="mt-0.5 text-[13px] leading-snug text-scout-text">{annotation.comment}</p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
        {annotations.length > 0 && (
          <div className="flex items-center px-4 pt-3">
            <div className="flex h-9 items-center rounded-full border border-scout-hairline-faint bg-scout-lift/70 text-[14px] font-semibold text-scout-text">
              <button type="button" onClick={() => setShowAnnotationReview((open) => !open)} className="flex h-full items-center gap-2 rounded-l-full pl-3.5 pr-1.5 hover:bg-scout-lift" aria-expanded={showAnnotationReview}>
                <MessageSquare size={15} strokeWidth={1.8} />
                <span>{annotations.length} annotation{annotations.length === 1 ? "" : "s"}</span>
              </button>
              <button type="button" onClick={() => { annotations.forEach((annotation) => onRemoveAnnotation?.(annotation.id)); setShowAnnotationReview(false); }} className="mr-1 flex h-7 w-7 items-center justify-center rounded-full text-scout-muted hover:bg-scout-input-bg hover:text-scout-text" aria-label="Clear annotations">
                <X size={14} />
              </button>
            </div>
          </div>
        )}
        {(fileAttachments.length > 0 || chatImages.length > 0) && (
          <div className="flex gap-2.5 overflow-x-auto px-4 pt-3 pb-0.5">
            {chatImages.map((image) => (
              <AttachmentCard key={image.id} path={image.name} name={image.name} size={image.size} baseUrl={baseUrl} token={token} previewUrl={`${baseUrl}${image.url}`} onRemove={() => setChatImages((current) => current.filter((item) => item.id !== image.id))} />
            ))}
            {fileAttachments.map((file) => (
              <AttachmentCard key={file.abs_path} path={file.abs_path} name={file.filename} size={file.size} baseUrl={baseUrl} token={token} onRemove={() => setFileAttachments((current) => current.filter((item) => item.abs_path !== file.abs_path))} />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            cursorPosRef.current = e.target.selectionStart ?? 0;
            setValue(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          placeholder={
            disabled
              ? "Waiting for response..."
              : welcomeMode
                ? "Describe what you want to explore…"
                : annotations.length > 0
                  ? "Ask for follow-up changes"
                  : "How can I help you?"
          }
          rows={1}
          className={`block w-full shrink-0 resize-none bg-transparent px-5 leading-relaxed text-scout-text outline-none placeholder:text-scout-muted/80 ${
            welcomeMode ? "pt-3 pb-1" : "pt-4 pb-2"
          } ${
            welcomeMode ? "text-base" : "text-[15px]"
          }`}
          style={{ minHeight: minH }}
        />

        <div className="flex items-center justify-between px-3 pb-3 pt-0">
          <div className="flex min-w-0 items-center gap-0.5">
            <button
              ref={plusBtnRef}
              onClick={() => setShowPlusMenu((p) => !p)}
              disabled={disabled}
              className={`flex items-center justify-center rounded-full text-scout-muted hover:bg-scout-lift hover:text-scout-text transition disabled:opacity-30 ${
                welcomeMode ? "w-9 h-9" : "w-8 h-8"
              }`}
              aria-label="Attach files and more"
            >
              <Plus size={welcomeMode ? 18 : 16} />
            </button>
            <button
              ref={approvalBtnRef}
              type="button"
              onClick={() => setShowApprovalMenu((open) => !open)}
              disabled={approvalModeChanging}
              className={`flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-scout-lift disabled:opacity-45 ${
                approvalMode === "full_access"
                  ? "text-scout-warning"
                  : "text-scout-muted hover:text-scout-text"
              }`}
              aria-label={`Approval mode: ${approvalLabel}`}
              aria-expanded={showApprovalMenu}
            >
              <ApprovalIcon size={15} className="shrink-0" />
              <span className="hidden truncate sm:inline">{approvalLabel}</span>
              <ChevronDown size={13} className={`hidden shrink-0 transition-transform sm:block ${showApprovalMenu ? "rotate-180" : ""}`} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                void handleChatUpload(files);
                if (fileInputRef.current) fileInputRef.current.value = "";
                setShowPlusMenu(false);
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              ref={modelBtnRef}
              onClick={() => setShowModelMenu((p) => !p)}
              disabled={modelDisabled}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-pill text-[13px] font-bold text-scout-text/80 hover:text-scout-text hover:bg-scout-lift/80 border border-transparent transition-all disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="truncate max-w-[160px]">{shortModel}</span>
              <ChevronDown size={14} className={`transition-transform ${showModelMenu ? "rotate-180" : ""}`} />
            </button>

            {isLoading && (
              <button
                onClick={onStop}
                className={`${sendBtnClass} border border-scout-hairline bg-scout-lift/80 text-scout-muted transition-colors hover:border-scout-error/35 hover:bg-scout-error-muted hover:text-scout-error active:scale-[0.98]`}
                aria-label="Stop execution"
                title="Stop"
              >
                <Square size={11} fill="currentColor" />
              </button>
            )}
            <button
              onClick={() => void handleSubmit()}
              disabled={disabled || pastingImages || (!hasText && fileAttachments.length === 0 && chatImages.length === 0 && annotations.length === 0) || visionBlocked}
              className={`${sendBtnClass} ${
                (hasText || fileAttachments.length > 0 || chatImages.length > 0 || annotations.length > 0) && !disabled && !visionBlocked
                  ? "bg-scout-text text-scout-bg hover:opacity-90 active:scale-[0.98]"
                  : "bg-scout-input-bg/80 text-scout-muted border border-scout-hairline-faint cursor-not-allowed"
              }`}
              aria-label={isLoading ? "Steer current turn" : "Send message"}
            >
              <ArrowUp size={18} strokeWidth={2.3} />
            </button>
          </div>
        </div>
      </div>
      {visionBlocked && (
        <div className="flex items-center gap-2 px-2 pt-2 text-xs text-scout-warning">
          <AlertTriangle size={13} />
          <span className="flex-1">This model cannot view images.</span>
          <button onClick={() => setShowModelMenu(true)} className="font-semibold hover:underline">Change model</button>
        </div>
      )}

      {!welcomeMode && (
        <p className="text-center text-caption text-scout-muted/75 mt-3">
          Scout can make mistakes. Check important work.
        </p>
      )}

      <AnchoredPopover
        open={showApprovalMenu}
        onClose={() => setShowApprovalMenu(false)}
        anchorRef={approvalBtnRef}
        placement="top-start"
        maxHeight={360}
        className="w-[min(28rem,calc(100vw-1rem))] p-2"
      >
        <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-scout-muted">
          How should Scout actions be approved?
        </div>
        {([
          {
            mode: "ask_always" as const,
            label: "Ask every time",
            description: "Ask before workspace edits, network access, and elevated actions.",
            icon: Hand,
          },
          {
            mode: "allow_edits" as const,
            label: "Allow edits",
            description: "Edit workspace files automatically; still ask for network access.",
            icon: ShieldCheck,
          },
          {
            mode: "full_access" as const,
            label: "Full access",
            description: "Perform allowed edits and network actions without asking.",
            icon: ShieldAlert,
          },
        ]).map((option) => {
          const Icon = option.icon;
          const active = option.mode === approvalMode;
          return (
            <button
              key={option.mode}
              type="button"
              onClick={() => {
                setShowApprovalMenu(false);
                void Promise.resolve(onSelectApprovalMode(option.mode)).catch(() => {});
              }}
              className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${active ? "bg-scout-lift" : "hover:bg-scout-lift/70"}`}
            >
              <Icon size={18} className="mt-0.5 shrink-0 text-scout-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-scout-text">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-scout-muted">{option.description}</span>
              </span>
              {active && <Check size={17} className="mt-0.5 shrink-0 text-scout-text" />}
            </button>
          );
        })}
        <p className="px-3 pb-1 pt-2 text-[11px] leading-relaxed text-scout-muted/80">
          Protected files, account permissions, and hard safety rules always remain enforced.
        </p>
      </AnchoredPopover>

      <AnchoredPopover
        open={showSlash && filteredCommands.length > 0}
        onClose={() => setShowSlash(false)}
        anchorRef={containerRef}
        placement="top-start"
        matchAnchorWidth
        className="p-1.5"
      >
        {filteredCommands.map((cmd, i) => (
          <button
            key={cmd.name}
            onClick={() => acceptSlashCommand(cmd)}
            onMouseEnter={() => setSlashIndex(i)}
            className={`${popoverMenuItem} ${i === slashIndex ? "bg-scout-lift" : ""}`}
          >
            <span className="font-mono text-scout-text font-semibold text-[13px]">{cmd.name}</span>
            <span className="text-scout-muted text-xs font-normal">{cmd.description}</span>
          </button>
        ))}
      </AnchoredPopover>

      <AnchoredPopover
        open={showAt && atFiles.length > 0 && !showSlash}
        onClose={() => setShowAt(false)}
        anchorRef={containerRef}
        placement="top-start"
        matchAnchorWidth
        maxHeight={240}
        className="p-1.5"
      >
        {atFiles.map((file, i) => (
          <button
            key={file.abs_path}
            onClick={() => acceptFileRef(file)}
            onMouseEnter={() => setAtIndex(i)}
            className={`${popoverMenuItem} ${i === atIndex ? "bg-scout-lift" : ""}`}
          >
            <FileText size={14} className="text-scout-muted shrink-0" />
            <span className="font-mono text-scout-text truncate text-xs flex-1">{file.path}</span>
            {file.scope && (
              <span className="text-[10px] px-1 rounded-btn border border-scout-hairline text-scout-muted shrink-0">
                {file.scope}
              </span>
            )}
          </button>
        ))}
      </AnchoredPopover>

      <AnchoredPopover
        open={showPlusMenu}
        onClose={() => setShowPlusMenu(false)}
        anchorRef={plusBtnRef}
        placement="bottom-start"
        className="w-52 p-1.5"
      >
        <button onClick={insertAtSymbol} className={popoverMenuItem}>
          <AtSign size={16} className="text-scout-muted" />
          <span className="text-scout-text">Reference files</span>
        </button>
        <button onClick={insertSlash} className={popoverMenuItem}>
          <Command size={16} className="text-scout-muted" />
          <span className="text-scout-text">Commands</span>
        </button>
        {onUpload && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className={popoverMenuItem}
          >
            <Upload size={16} className="text-scout-muted" />
            <span className="text-scout-text">Upload files</span>
          </button>
        )}
      </AnchoredPopover>

      <AnchoredPopover
        open={showModelMenu && models.length > 0}
        onClose={() => setShowModelMenu(false)}
        anchorRef={modelBtnRef}
        placement="bottom-end"
        className="w-72 p-1.5"
      >
        {models.map((m) => {
          const isActive = m === currentModel;
          const slash = m.indexOf("/");
          const provider = slash > -1 ? m.slice(0, slash + 1) : "";
          const name = slash > -1 ? m.slice(slash + 1) : m;
          const vision = capabilities[m]?.vision ?? "unverified";
          const incompatible = (hasImageAttachment || chatImages.length > 0 || requiresVision) && vision !== "supported";
          return (
            <button
              key={m}
              disabled={incompatible}
              title={incompatible ? "A verified vision model is required for attached images." : undefined}
              onClick={() => {
                onSelectModel(m);
                setShowModelMenu(false);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isActive
                  ? "text-scout-text bg-scout-lift"
                  : "text-scout-text/70 hover:bg-scout-input-bg hover:text-scout-text"
              }`}
            >
              <span className="flex-1 truncate">
                {provider && <span className="text-scout-muted">{provider}</span>}
                {name}
              </span>
              {vision === "supported" && <Camera size={14} className="text-scout-muted shrink-0" />}
              {vision === "unverified" && <span className="text-[10px] text-scout-muted">Unverified</span>}
              {isActive && <Check size={15} className="shrink-0 text-scout-text" />}
            </button>
          );
        })}
      </AnchoredPopover>

    </div>
  );
}
