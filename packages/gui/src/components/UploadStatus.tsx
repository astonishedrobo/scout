import { useEffect, useRef, useState } from "react";
import { Upload, Loader2, Check, AlertCircle, X } from "lucide-react";
import type { UploadItem } from "../hooks/useUploads";
import { useExitingItems } from "../hooks/useExitingItems";
import { EXIT_MS } from "../motion";

interface UploadStatusProps {
  uploads: UploadItem[];
  onUpload: (files: FileList | null) => void;
  onDismiss: (id: string) => void;
  activeCount: number;
  errorCount: number;
}

export function UploadStatus({
  uploads,
  onUpload,
  onDismiss,
  activeCount,
  errorCount,
}: UploadStatusProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Dismissing an upload drops it from the array immediately, so retain the row
  // briefly to let it fade rather than blink out.
  const uploadRows = useExitingItems(uploads, (u) => u.id, EXIT_MS.collapse);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Auto-open while uploads are active
  useEffect(() => {
    if (activeCount > 0) setOpen(true);
  }, [activeCount]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const badge = activeCount > 0 ? activeCount : errorCount > 0 ? errorCount : 0;
  const badgeColor = errorCount > 0 && activeCount === 0 ? "bg-scout-error" : "bg-scout-text";

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => inputRef.current?.click()}
        className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-btn text-sm
                   text-scout-text-secondary hover:text-scout-text-primary
                   hover:bg-scout-surface-hover transition-colors"
        title="Upload files to your workspace"
      >
        <Upload size={16} />
        <span className="hidden sm:inline">Upload</span>
        {badge > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setOpen((p) => !p); }}
            className={`absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full
                       ${badgeColor} text-white text-[10px] font-semibold
                       flex items-center justify-center cursor-pointer`}
            title="Show upload status"
          >
            {badge}
          </span>
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onUpload(e.target.files);
          if (inputRef.current) inputRef.current.value = "";
          setOpen(true);
        }}
      />

      {open && uploadRows.length > 0 && (
        <div
          className="absolute top-full right-0 mt-1 w-72 bg-scout-surface border border-scout-border
                     rounded-btn overflow-hidden z-50"
        >
          <div className="px-3 py-2 border-b border-scout-border text-[11px] uppercase tracking-wider
                          text-scout-text-secondary/70 font-medium">
            Workspace uploads
          </div>
          <div className="max-h-64 overflow-y-auto">
            {uploadRows.map(({ item: u, exiting }) => (
              <div
                key={u.id}
                className={`flex items-center gap-2.5 px-3 py-2 text-sm border-b border-scout-border/40 last:border-0 ${
                  exiting ? "animate-collapse-out pointer-events-none" : ""
                }`}
              >
                {u.status === "uploading" && (
                  <Loader2 size={14} className="text-scout-text animate-spin flex-shrink-0" />
                )}
                {u.status === "done" && (
                  <Check size={14} className="text-scout-success flex-shrink-0" />
                )}
                {u.status === "error" && (
                  <AlertCircle size={14} className="text-scout-error flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-scout-text-primary truncate">{u.name}</p>
                  {u.status === "error" && u.error && (
                    <p className="text-[11px] text-scout-error truncate">{u.error}</p>
                  )}
                </div>
                {u.status === "error" && (
                  <button
                    onClick={() => onDismiss(u.id)}
                    className="p-0.5 rounded text-scout-text-secondary hover:text-scout-text-primary flex-shrink-0"
                    title="Dismiss"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
