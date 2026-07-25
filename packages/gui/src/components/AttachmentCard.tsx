import {
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  X,
} from "lucide-react";
import { AuthenticatedImage } from "./AuthenticatedImage";

interface AttachmentCardProps {
  path: string;
  name?: string;
  size?: number;
  baseUrl?: string;
  token?: string | null;
  previewUrl?: string;
  onRemove?: () => void;
  className?: string;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);

export function isImageAttachment(path: string) {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

function extensionOf(path: string) {
  const clean = path.split(/[?#]/)[0] ?? path;
  const name = clean.split("/").pop() ?? clean;
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

function displayName(path: string, preferred?: string) {
  return preferred || decodeURIComponent(path.split(/[?#]/)[0]?.split("/").pop() || "Attachment");
}

function formatSize(size?: number) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function filePresentation(path: string) {
  const ext = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(ext)) return { label: ext === "svg" ? "SVG" : "Image", Icon: FileImage, tone: "text-scout-cyan bg-scout-cyan/12" };
  if (ext === "pdf") return { label: "PDF", Icon: FileText, tone: "text-scout-error bg-scout-error-muted" };
  if (["md", "mdx", "txt", "rtf"].includes(ext)) return { label: ext ? ext.toUpperCase() : "Text", Icon: FileText, tone: "text-scout-text bg-scout-input-bg" };
  if (["csv", "xls", "xlsx", "ods", "parquet"].includes(ext)) return { label: ext.toUpperCase(), Icon: FileSpreadsheet, tone: "text-scout-success bg-scout-success-muted" };
  if (["ppt", "pptx", "odp"].includes(ext)) return { label: ext.toUpperCase(), Icon: Presentation, tone: "text-scout-peach bg-scout-peach-muted" };
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) return { label: ext.toUpperCase(), Icon: FileArchive, tone: "text-scout-amber bg-scout-amber-muted" };
  if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "css", "html", "json", "yaml", "yml", "toml", "sh", "sql"].includes(ext)) return { label: ext.toUpperCase(), Icon: FileCode2, tone: "text-scout-lavender bg-scout-lavender-muted" };
  return { label: ext ? ext.toUpperCase() : "File", Icon: FileText, tone: "text-scout-muted bg-scout-input-bg" };
}

/** Compact, type-aware attachment treatment shared by the composer and transcript. */
export function AttachmentCard({
  path,
  name,
  size,
  baseUrl = "",
  token = null,
  previewUrl,
  onRemove,
  className = "",
}: AttachmentCardProps) {
  const title = displayName(path, name);
  const presentation = filePresentation(title || path);
  const { Icon } = presentation;
  const image = isImageAttachment(title || path);
  const subtitle = [presentation.label, formatSize(size)].filter(Boolean).join(" · ");

  return (
    <div className={`group/attachment relative flex h-[48px] w-[170px] shrink-0 items-center gap-2 rounded-btn border border-scout-hairline-faint bg-scout-lift/35 px-2 pr-2.5 ${className}`} title={title}>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-btn ${presentation.tone}`}>
        {image ? (
          <AuthenticatedImage
            src={previewUrl ?? `${baseUrl}/files/content?path=${encodeURIComponent(path)}`}
            token={token}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon size={18} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-caption font-semibold leading-tight text-scout-text">{title}</p>
        <p className="mt-0.5 truncate text-micro font-medium text-scout-muted">{subtitle}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center p-1 text-scout-text"
          aria-label={`Remove ${title}`}
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-scout-hairline bg-scout-panel shadow-sm transition-colors hover:bg-scout-lift">
            <X size={12} />
          </span>
        </button>
      )}
    </div>
  );
}
