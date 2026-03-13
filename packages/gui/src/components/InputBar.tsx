import { useState, useRef, useCallback, useEffect } from "react";
import { Send, Plus, AtSign, FileText, Command, ChevronDown } from "lucide-react";

/* ── Slash commands ─────────────────────────────────────────────── */

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

/* ── Component ──────────────────────────────────────────────────── */

interface InputBarProps {
  baseUrl: string;
  onSubmit: (text: string) => void;
  onSlashCommand?: (command: string) => void;
  disabled: boolean;
  models: string[];
  currentModel: string;
  onSelectModel: (model: string) => void;
  centered?: boolean;
}

export function InputBar({ baseUrl, onSubmit, onSlashCommand, disabled, models, currentModel, onSelectModel, centered = false }: InputBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Plus menu state ────────────────────────────────────────────
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPlusMenu) return;
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPlusMenu]);

  // ── Slash command state ─────────────────────────────────────────
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  const slashFilter = value.startsWith("/") ? value.toLowerCase() : "";
  const filteredCommands = slashFilter
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashFilter))
    : SLASH_COMMANDS;

  useEffect(() => {
    if (value.startsWith("/") && !value.includes(" ")) {
      setShowSlash(true);
      setSlashIndex(0);
    } else {
      setShowSlash(false);
    }
  }, [value]);

  // ── @ file autocomplete state ──────────────────────────────────
  const [showAt, setShowAt] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [atPrefix, setAtPrefix] = useState("");
  const [atStartPos, setAtStartPos] = useState(0);
  const fetchIdRef = useRef(0);
  const cursorPosRef = useRef(0);

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
    const pos = cursorPosRef.current || value.length;
    const before = value.slice(0, pos);
    const atMatch = before.match(/(^|[\s])@([^\s]*)$/);

    if (atMatch) {
      const prefix = atMatch[2];
      setAtPrefix(prefix);
      setAtStartPos(before.length - atMatch[0].length + atMatch[1].length);
      setShowAt(true);
      setAtIndex(0);

      const id = ++fetchIdRef.current;
      fetch(`${baseUrl}/files?prefix=${encodeURIComponent(prefix)}&limit=20`)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
        })
        .then((data) => {
          if (fetchIdRef.current === id) setAtFiles(data.files ?? []);
        })
        .catch(() => {
          if (fetchIdRef.current === id) setAtFiles([]);
        });
    } else {
      setShowAt(false);
      setAtFiles([]);
    }
  }, [value, baseUrl]);

  // ── Auto-resize textarea ───────────────────────────────────────
  const minH = centered ? 80 : 40;
  const maxH = centered ? 200 : 160;

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.max(Math.min(ta.scrollHeight, maxH), minH) + "px";
  }, [value, minH, maxH]);

  // ── Accept helpers ─────────────────────────────────────────────
  const acceptSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      setShowSlash(false);
      setValue("");
      if (onSlashCommand) onSlashCommand(cmd.name);
    },
    [onSlashCommand],
  );

  const acceptFileRef = useCallback(
    (filePath: string) => {
      const before = value.slice(0, atStartPos);
      const after = value.slice(atStartPos + 1 + atPrefix.length);
      setValue(before + "@" + filePath + " " + after);
      setShowAt(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
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

  // ── Submit ─────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    if (showSlash && filteredCommands.length > 0) {
      acceptSlashCommand(filteredCommands[slashIndex]);
      return;
    }

    if (showAt && atFiles.length > 0) {
      acceptFileRef(atFiles[atIndex]);
      return;
    }

    if (trimmed.startsWith("/")) {
      const match = SLASH_COMMANDS.find((c) => c.name === trimmed);
      if (match) {
        setValue("");
        if (onSlashCommand) onSlashCommand(match.name);
        return;
      }
    }

    onSubmit(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, disabled, onSubmit, onSlashCommand, showSlash, filteredCommands, slashIndex, acceptSlashCommand, showAt, atFiles, atIndex, acceptFileRef]);

  // ── Keyboard navigation ────────────────────────────────────────
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
          acceptSlashCommand(filteredCommands[slashIndex]);
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
          acceptFileRef(atFiles[atIndex]);
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
    [handleSubmit, showSlash, filteredCommands, slashIndex, acceptSlashCommand, showAt, atFiles, atIndex, acceptFileRef],
  );

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  // ── Model dropdown state ────────────────────────────────────────
  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showModelMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelMenu]);

  const hasText = value.trim().length > 0;

  const shortModel = currentModel
    ? currentModel.split("/").pop() ?? currentModel
    : "No model";

  return (
    <div className={`relative w-full ${centered ? "max-w-2xl" : "max-w-3xl flex-shrink-0"} mx-auto px-3 ${centered ? "" : "pb-2 pt-1"}`}>
      {/* Slash command dropdown */}
      {showSlash && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-scout-surface border border-scout-border rounded-lg shadow-xl overflow-hidden z-50">
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.name}
              onClick={() => acceptSlashCommand(cmd)}
              onMouseEnter={() => setSlashIndex(i)}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors
                ${i === slashIndex ? "bg-scout-surface-hover" : ""}`}
            >
              <span className="font-mono text-scout-text-primary font-medium text-[13px]">
                {cmd.name}
              </span>
              <span className="text-scout-text-secondary text-xs">
                {cmd.description}
              </span>
            </button>
          ))}
          <div className="px-3 py-1.5 border-t border-scout-border">
            <span className="text-[10px] text-scout-text-secondary">
              <kbd className="px-1 py-0.5 rounded bg-scout-bg border border-scout-border text-[10px] font-mono">Tab</kbd>
              {" "}to select{" \u00b7 "}
              <kbd className="px-1 py-0.5 rounded bg-scout-bg border border-scout-border text-[10px] font-mono">Esc</kbd>
              {" "}to dismiss
            </span>
          </div>
        </div>
      )}

      {/* @ file autocomplete dropdown */}
      {showAt && atFiles.length > 0 && !showSlash && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-scout-surface border border-scout-border rounded-lg shadow-xl overflow-hidden z-50 max-h-60 overflow-y-auto">
          {atFiles.map((file, i) => (
            <button
              key={file}
              onClick={() => acceptFileRef(file)}
              onMouseEnter={() => setAtIndex(i)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors
                ${i === atIndex ? "bg-scout-surface-hover" : ""}`}
            >
              <FileText size={14} className="text-scout-text-secondary flex-shrink-0" />
              <span className="font-mono text-scout-text-primary truncate text-xs">
                {file}
              </span>
            </button>
          ))}
          <div className="px-3 py-1.5 border-t border-scout-border">
            <span className="text-[10px] text-scout-text-secondary">
              <kbd className="px-1 py-0.5 rounded bg-scout-bg border border-scout-border text-[10px] font-mono">Tab</kbd>
              {" "}to select{" \u00b7 "}
              <kbd className="px-1 py-0.5 rounded bg-scout-bg border border-scout-border text-[10px] font-mono">Esc</kbd>
              {" "}to dismiss
            </span>
          </div>
        </div>
      )}

      {/* Input container */}
      <div
        className={`
          flex flex-col rounded-2xl border
          ${disabled ? "border-scout-border/50 opacity-60" : "border-scout-border"}
          bg-scout-input-bg overflow-visible relative
        `}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            cursorPosRef.current = e.target.selectionStart ?? 0;
            setValue(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? "Waiting for response..." : "How can I help you?"}
          rows={1}
          className="flex-1 bg-transparent text-sm text-scout-text-primary
                     placeholder:text-scout-text-secondary/50
                     resize-none outline-none
                     px-4 pt-3 pb-1"
          style={{ minHeight: minH, maxHeight: maxH }}
        />

        {/* Bottom row: + button | model selector | send */}
        <div className="flex items-center justify-between px-1.5 pb-1.5 pt-0">
          {/* Left: Plus button */}
          <div className="relative flex-shrink-0" ref={plusMenuRef}>
            <button
              onClick={() => setShowPlusMenu((p) => !p)}
              disabled={disabled}
              className="p-1.5 rounded-lg text-scout-text-secondary/60
                         hover:text-scout-text-primary hover:bg-scout-surface-hover
                         transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="More options"
            >
              <Plus size={18} />
            </button>

            {showPlusMenu && (
              <div className="absolute bottom-full left-0 mb-1 w-52 bg-scout-surface border border-scout-border rounded-lg shadow-xl overflow-hidden z-50">
                <button
                  onClick={insertAtSymbol}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm
                             hover:bg-scout-surface-hover transition-colors"
                >
                  <AtSign size={16} className="text-scout-text-secondary" />
                  <span className="text-scout-text-primary">Reference files</span>
                </button>
                <button
                  onClick={insertSlash}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm
                             hover:bg-scout-surface-hover transition-colors"
                >
                  <Command size={16} className="text-scout-text-secondary" />
                  <span className="text-scout-text-primary">Commands</span>
                </button>
              </div>
            )}
          </div>

          {/* Right: Model selector + Send */}
          <div className="flex items-center gap-1">
            {/* Model selector */}
            <div className="relative" ref={modelMenuRef}>
              <button
                onClick={() => setShowModelMenu((p) => !p)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs
                           text-scout-text-secondary hover:text-scout-text-primary
                           hover:bg-scout-surface-hover transition-colors"
              >
                <span className="truncate max-w-[140px]">{shortModel}</span>
                <ChevronDown size={12} className={`transition-transform ${showModelMenu ? "rotate-180" : ""}`} />
              </button>

              {showModelMenu && models.length > 0 && (
                <div className="absolute bottom-full right-0 mb-1 w-64 bg-scout-surface border border-scout-border rounded-lg shadow-xl max-h-48 overflow-y-auto z-50">
                  {models.map((m) => (
                    <button
                      key={m}
                      onClick={() => { onSelectModel(m); setShowModelMenu(false); }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-scout-surface-hover transition-colors
                        ${m === currentModel ? "text-scout-text-primary" : "text-scout-text-secondary"}`}
                    >
                      {m}
                      {m === currentModel && <span className="ml-1 opacity-50">(active)</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send button */}
            <button
              onClick={handleSubmit}
              disabled={disabled || !hasText}
              className={`p-1.5 rounded-lg transition-colors flex-shrink-0
                ${hasText && !disabled
                  ? "bg-scout-text-primary text-scout-bg hover:opacity-90"
                  : "text-scout-text-secondary/30 cursor-not-allowed"
                }`}
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-center text-[11px] text-scout-text-secondary/50 mt-1.5 pb-1">
        AI responses may make mistakes. Please verify responses.
      </p>
    </div>
  );
}
