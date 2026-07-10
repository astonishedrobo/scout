import { useRef, useState } from "react";
import { Upload, Loader2, Check, AlertCircle, X } from "lucide-react";
import { AnchoredPopover } from "./ui/AnchoredPopover";
import {
  headerActionActiveClass,
  headerActionButtonClass,
  headerActionIdleClass,
} from "./ui/headerControls";
import type { UploadItem } from "../hooks/useUploads";

interface UploadButtonProps {
  uploads: UploadItem[];
  activeCount: number;
  errorCount: number;
  onUpload: (files: FileList | null) => void | Promise<unknown>;
  onDismiss: (id: string) => void;
}

/**
 * Header workspace-upload control. Uploads run in the background and never
 * block chatting — the button only hints at pending files ("2 uploading…")
 * so the user knows the agent can't see them yet, then returns to normal.
 */
export function UploadButton({
  uploads,
  activeCount,
  errorCount,
  onUpload,
  onDismiss,
}: UploadButtonProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showStatus, setShowStatus] = useState(false);

  const busy = activeCount > 0;
  const hasItems = uploads.length > 0;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => {
          // While uploads are listed, the button doubles as a status toggle;
          // otherwise it goes straight to the file picker.
          if (hasItems) setShowStatus((p) => !p);
          else fileInputRef.current?.click();
        }}
        className={`${headerActionButtonClass} ${
          busy
            ? "border-scout-action/30 bg-scout-action-muted text-scout-text"
            : errorCount > 0
              ? "border-scout-error/30 bg-scout-error-muted text-scout-error"
              : hasItems
                ? headerActionActiveClass
                : headerActionIdleClass
        }`}
        title={
          busy
            ? "Files are still uploading — the agent can't see them until they finish"
            : "Upload files to your workspace"
        }
      >
        {busy ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            <span className="hidden sm:inline">{activeCount} uploading…</span>
            <span className="sm:hidden">{activeCount}</span>
          </>
        ) : errorCount > 0 ? (
          <>
            <AlertCircle size={15} />
            <span className="hidden sm:inline">{errorCount} failed</span>
            <span className="sm:hidden">{errorCount}</span>
          </>
        ) : (
          <>
            <Upload size={15} />
            <span className="hidden sm:inline">Upload</span>
          </>
        )}
      </button>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onUpload(e.target.files);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setShowStatus(true);
        }}
      />

      <AnchoredPopover
        open={showStatus && hasItems}
        onClose={() => setShowStatus(false)}
        anchorRef={btnRef}
        placement="bottom-end"
        className="w-72 p-1.5"
      >
        <div className="px-2 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-scout-muted">
          Workspace uploads
        </div>
        {uploads.map((u) => (
          <div
            key={u.id}
            className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-[13px] font-medium"
          >
            {u.status === "uploading" && (
              <Loader2 size={14} className="text-scout-text animate-spin shrink-0" />
            )}
            {u.status === "done" && <Check size={14} className="text-scout-success shrink-0" />}
            {u.status === "error" && (
              <AlertCircle size={14} className="text-scout-error shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-scout-text truncate">{u.name}</p>
              {u.status === "error" && u.error && (
                <p className="text-[11px] text-scout-error truncate">{u.error}</p>
              )}
            </div>
            {u.status === "error" && (
              <button
                onClick={() => onDismiss(u.id)}
                className="p-1.5 rounded-btn text-scout-muted hover:text-scout-text shrink-0"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center gap-2.5 px-2 py-2 mt-0.5 rounded-lg text-[13px] font-medium text-scout-text hover:bg-scout-lift transition-colors border-t border-scout-hairline-faint"
        >
          <Upload size={14} className="text-scout-muted" />
          Upload more files
        </button>
      </AnchoredPopover>
    </>
  );
}
