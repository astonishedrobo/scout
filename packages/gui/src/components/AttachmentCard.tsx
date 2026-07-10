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
  if (IMAGE_EXTENSIONS.has(ext)) return { label: ext === "svg" ? "SVG" : "Image", Icon: FileImage, tone: "text-[#38bdf8] bg-[#0c4a6e]/45" };
  if (ext === "pdf") return { label: "PDF", Icon: FileText, tone: "text-white bg-[#e5484d]" };
  if (["md", "mdx", "txt", "rtf"].includes(ext)) return { label: ext ? ext.toUpperCase() : "Text", Icon: FileText, tone: "text-scout-text bg-scout-input-bg" };
  if (["csv", "xls", "xlsx", "ods", "parquet"].includes(ext)) return { label: ext.toUpperCase(), Icon: FileSpreadsheet, tone: "text-[#4ade80] bg-[#14532d]/45" };
  if (["ppt", "pptx", "odp"].includes(ext)) return { label: ext.toUpperCase(), Icon: Presentation, tone: "text-[#fb923c] bg-[#7c2d12]/45" };
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) return { label: ext.toUpperCase(), Icon: FileArchive, tone: "text-[#facc15] bg-[#713f12]/45" };
  if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "css", "html", "json", "yaml", "yml", "toml", "sh", "sql"].includes(ext)) return { label: ext.toUpperCase(), Icon: FileCode2, tone: "text-[#c4b5fd] bg-[#4c1d95]/40" };
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
    <div className={`group/attachment relative flex h-[54px] w-[178px] shrink-0 items-center gap-2.5 rounded-[13px] border border-scout-hairline bg-scout-lift/45 px-2 pr-3 ${className}`} title={title}>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[9px] ${presentation.tone}`}>
        {image ? (
          <AuthenticatedImage
            src={previewUrl ?? `${baseUrl}/files/content?path=${encodeURIComponent(path)}`}
            token={token}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon size={18} strokeWidth={1.8} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-semibold leading-tight text-scout-text">{title}</p>
        <p className="mt-0.5 truncate text-[11px] font-medium text-scout-muted">{subtitle}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-scout-hairline bg-scout-panel text-scout-text shadow-sm hover:bg-scout-lift"
          aria-label={`Remove ${title}`}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
