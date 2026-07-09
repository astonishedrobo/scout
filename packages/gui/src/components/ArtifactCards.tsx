import type { Artifact } from "scout-core";
import { ArrowUpRight, FileCode2, Image, FileText, Table2 } from "lucide-react";
import { MemoryUpdateChip } from "./MemoryUpdateChip";
import { AuthenticatedImage } from "./AuthenticatedImage";

function hiddenSegment(path: string) {
  return path.split("/").some((part) => part.startsWith("."));
}

function isMemoryArtifact(artifact: Artifact) {
  const path = artifact.path || "";
  return path.includes(".scout/memories/") || /(^|\/)(MEMORY|memory_summary|raw_memories)\.md$/.test(path);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactKind(artifact: Artifact) {
  if (artifact.renderer === "markdown") return "Document · MD";
  if (artifact.renderer === "image") return artifact.mime_type.split("/")[1]?.toUpperCase() || "Image";
  if (artifact.renderer === "csv") return "Table · CSV";
  return artifact.renderer.toUpperCase();
}

export function ArtifactCards({
  artifacts,
  onOpen,
  onOpenMemories,
  baseUrl = "",
  token = null,
}: {
  artifacts: Artifact[];
  onOpen: (artifact: Artifact) => void;
  onOpenMemories?: () => void;
  baseUrl?: string;
  token?: string | null;
}) {
  const previewableArtifacts = artifacts.filter((artifact) => !hiddenSegment(artifact.path || ""));
  const hasMemoryUpdate = artifacts.some((artifact) => hiddenSegment(artifact.path || "") && isMemoryArtifact(artifact));
  if (!previewableArtifacts.length && !hasMemoryUpdate) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {hasMemoryUpdate && (
        <MemoryUpdateChip onOpenMemories={onOpenMemories} />
      )}
      {previewableArtifacts.map((artifact) => {
        const Icon =
          artifact.renderer === "image"
            ? Image
            : artifact.renderer === "csv"
              ? Table2
              : artifact.renderer === "code"
                ? FileCode2
                : FileText;
        return (
          <button
            key={artifact.id}
            onClick={() => onOpen(artifact)}
            className="group flex w-full max-w-[45rem] items-center gap-3 rounded-xl border border-scout-hairline-faint bg-scout-panel/65 px-4 py-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all hover:bg-scout-lift/80"
          >
            <span className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-scout-hairline-faint bg-scout-input-bg">
              {artifact.renderer === "image" ? (
                <AuthenticatedImage
                  src={`${baseUrl}/artifacts/content?path=${encodeURIComponent(artifact.path)}`}
                  token={token}
                  alt={artifact.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <>
                  <span className="absolute -bottom-5 -right-4 h-16 w-12 rotate-[-7deg] rounded-lg border border-scout-hairline-faint bg-scout-panel shadow-sm" />
                  <Icon size={19} className="relative text-scout-muted" />
                </>
              )}
            </span>
            <span className="flex min-w-0 flex-1 items-center">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-scout-text">
                  {artifact.title}
                </span>
                <span className="mt-0.5 block truncate text-xs text-scout-muted">
                  {artifactKind(artifact)} · {formatSize(artifact.size)}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-scout-hairline-faint bg-scout-input-bg/80 px-3 py-2 text-xs font-semibold text-scout-text group-hover:bg-scout-panel">
                Open
                <ArrowUpRight size={13} className="text-scout-muted" />
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
