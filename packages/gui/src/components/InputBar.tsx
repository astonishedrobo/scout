import { useState, useRef, useCallback, useEffect } from "react";
import {
  Send,
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
} from "lucide-react";
import { AnchoredPopover } from "./ui/AnchoredPopover";
import type { ChatImage } from "scout-core";
import { AuthenticatedImage } from "./AuthenticatedImage";

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
  scope: "personal" | "shared" | null;
}

interface InputBarProps {
  baseUrl: string;
  onSubmit: (text: string, attachments?: string[], chatImages?: ChatImage[], onAccepted?: () => void) => Promise<boolean>;
  onSlashCommand?: (command: string) => void;
  disabled: boolean;
  isLoading?: boolean;
  onStop?: () => void;
  models: string[];
  capabilities: Record<string, { vision: "supported" | "unsupported" | "unverified" }>;
  currentModel: string;
  onSelectModel: (model: string) => void;
  isMultiUser?: boolean;
  token?: string | null;
  uploadingCount?: number;
  onUpload?: (files: FileList | null) => void;
  welcomeMode?: boolean;
  embedded?: boolean;
  requiresVision?: boolean;
  ensureSession: () => Promise<string>;
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
  token,
  uploadingCount = 0,
  onUpload,
  welcomeMode = false,
  embedded = false,
  requiresVision = false,
  ensureSession,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [showAt, setShowAt] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atFiles, setAtFiles] = useState<FileEntry[]>([]);
  const [atPrefix, setAtPrefix] = useState("");
  const [atStartPos, setAtStartPos] = useState(0);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<FileEntry[]>([]);
  const [chatImages, setChatImages] = useState<ChatImage[]>([]);
  const [pastingImages, setPastingImages] = useState(false);

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
                typeof f === "string" ? { path: f, abs_path: f, scope: null } : f,
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

  const minH = welcomeMode ? 120 : 44;
  const maxH = welcomeMode ? 240 : 160;

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.max(Math.min(ta.scrollHeight, maxH), minH) + "px";
  }, [value, minH, maxH]);

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
      const insertPath = file.abs_path;
      const before = value.slice(0, atStartPos);
      const after = value.slice(atStartPos + 1 + atPrefix.length);
      const newValue = before + "@" + insertPath + " " + after;
      const newPos = before.length + 1 + insertPath.length + 1;
      cursorPosRef.current = newPos;
      setValue(newValue);
      if (/\.(png|jpe?g|webp|gif)$/i.test(file.abs_path)) {
        setImageAttachments((prev) => prev.some((p) => p.abs_path === file.abs_path) ? prev : [...prev, file]);
      }
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
    if ((!trimmed && imageAttachments.length === 0 && chatImages.length === 0) || disabled) return;
    if ((imageAttachments.length > 0 || chatImages.length > 0) && capabilities[currentModel]?.vision !== "supported") return;

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

    let cleared = false;
    const clearAcceptedDraft = () => {
      cleared = true;
      setValue("");
      setImageAttachments([]);
      setChatImages([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    };
    const accepted = await onSubmit(
      trimmed,
      imageAttachments.map((a) => a.abs_path),
      chatImages,
      clearAcceptedDraft,
    );
    if (accepted && !cleared) {
      clearAcceptedDraft();
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
    imageAttachments,
    capabilities,
    currentModel,
    chatImages,
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
  const visionBlocked = (imageAttachments.length > 0 || chatImages.length > 0) && capabilities[currentModel]?.vision !== "supported";
  const shortModel = currentModel ? (currentModel.split("/").pop() ?? currentModel) : "No model";

  const popoverMenuItem =
    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium hover:bg-scout-lift/80 transition-colors text-left";

  const sendBtnClass = welcomeMode
    ? "flex items-center gap-2 px-4 py-2 rounded-pill flex-shrink-0 transition-all text-sm font-semibold"
    : "flex items-center gap-1.5 px-3 py-1.5 rounded-pill flex-shrink-0 transition-all text-xs font-semibold";

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

      <div
        className={`flex flex-col bg-scout-panel/90 backdrop-blur-xl overflow-visible border border-scout-hairline-faint shadow-pop focus-within:border-scout-hairline focus-within:ring-1 focus-within:ring-scout-text/10 transition-all ${
          welcomeMode ? "rounded-hero" : "rounded-card"
        } ${disabled ? "opacity-60" : ""}`}
      >
        {(imageAttachments.length > 0 || chatImages.length > 0) && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {chatImages.map((image) => (
              <div key={image.id} className="relative shrink-0 w-20 rounded-xl border border-scout-hairline-faint bg-scout-input-bg overflow-hidden">
                <AuthenticatedImage src={`${baseUrl}${image.url}`} token={token ?? null} className="h-14 w-full object-cover" alt={image.name} />
                <div className="truncate px-1.5 py-1 text-[10px] text-scout-muted">{image.name}</div>
                <button onClick={() => setChatImages((p) => p.filter((x) => x.id !== image.id))} className="absolute right-1 top-1 rounded-full bg-scout-void/70 p-0.5 text-white" aria-label="Remove image"><X size={11} /></button>
              </div>
            ))}
            {imageAttachments.map((image) => (
              <div key={image.abs_path} className="relative shrink-0 w-20 rounded-xl border border-scout-hairline-faint bg-scout-input-bg overflow-hidden">
                <AuthenticatedImage src={`${baseUrl}/files/content?path=${encodeURIComponent(image.abs_path)}`} token={token ?? null} className="h-14 w-full object-cover" alt={image.path} />
                <div className="truncate px-1.5 py-1 text-[10px] text-scout-muted">{image.path.split("/").pop()}</div>
                <button onClick={() => setImageAttachments((p) => p.filter((x) => x.abs_path !== image.abs_path))} className="absolute right-1 top-1 rounded-full bg-scout-void/70 p-0.5 text-white" aria-label="Remove image"><X size={11} /></button>
              </div>
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
                : "How can I help you?"
          }
          rows={1}
          className={`flex-1 bg-transparent text-scout-text placeholder:text-scout-muted/80 resize-none outline-none px-5 pt-4 pb-2 leading-relaxed ${
            welcomeMode ? "text-base" : "text-[15px]"
          }`}
          style={{ minHeight: minH, maxHeight: maxH }}
        />

        <div className="flex items-center justify-between px-3 pb-3 pt-0">
          <div className="flex items-center gap-1">
            <button
              ref={plusBtnRef}
              onClick={() => setShowPlusMenu((p) => !p)}
              disabled={disabled}
              className={`flex items-center justify-center rounded-xl bg-scout-input-bg/90 text-scout-text border border-scout-hairline-faint hover:bg-scout-lift transition disabled:opacity-30 ${
                welcomeMode ? "w-9 h-9" : "w-8 h-8"
              }`}
              aria-label="Attach files and more"
            >
              <Plus size={welcomeMode ? 18 : 16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onUpload?.(e.target.files);
                if (fileInputRef.current) fileInputRef.current.value = "";
                setShowPlusMenu(false);
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              ref={modelBtnRef}
              onClick={() => setShowModelMenu((p) => !p)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-pill text-[13px] font-medium text-scout-text/70 hover:text-scout-text hover:bg-scout-lift/80 border border-transparent hover:border-scout-hairline-faint transition-all"
            >
              <span className="truncate max-w-[160px]">{shortModel}</span>
              <ChevronDown size={14} className={`transition-transform ${showModelMenu ? "rotate-180" : ""}`} />
            </button>

            {isLoading ? (
              <button
                onClick={onStop}
                className={`${sendBtnClass} bg-scout-text text-scout-bg hover:opacity-90 active:scale-[0.98]`}
                aria-label="Stop execution"
              >
                <Square size={welcomeMode ? 14 : 12} fill="currentColor" />
                {welcomeMode && <span>Stop</span>}
              </button>
            ) : (
              <button
                onClick={() => void handleSubmit()}
                disabled={disabled || pastingImages || (!hasText && imageAttachments.length === 0 && chatImages.length === 0) || visionBlocked}
                className={`${sendBtnClass} ${
                  (hasText || imageAttachments.length > 0 || chatImages.length > 0) && !disabled && !visionBlocked
                    ? "bg-scout-text text-scout-bg hover:opacity-90 active:scale-[0.98]"
                    : "bg-scout-input-bg/80 text-scout-muted border border-scout-hairline-faint cursor-not-allowed"
                }`}
                aria-label="Send message"
              >
                <Send size={welcomeMode ? 16 : 14} />
                {welcomeMode && <span>Send</span>}
              </button>
            )}
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
          AI responses may make mistakes. Please verify responses.
        </p>
      )}

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
          const incompatible = (imageAttachments.length > 0 || chatImages.length > 0 || requiresVision) && vision !== "supported";
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
