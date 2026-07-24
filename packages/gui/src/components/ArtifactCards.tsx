import type { Artifact } from "scout-core";
import { FileCode2, Image, FileText, Table2 } from "lucide-react";
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

function artifactPathKey(path: string | undefined | null): string {
  let raw = (path || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  while (raw.startsWith("./")) raw = raw.slice(2);
  if (raw.startsWith("/workspace/")) raw = raw.slice("/workspace/".length);
  else if (raw.startsWith("workspace/shared/")) raw = `shared/${raw.slice("workspace/shared/".length)}`;
  else if (raw.startsWith("workspace/")) raw = raw.slice("workspace/".length);
  if (raw.startsWith("/shared/")) raw = `shared/${raw.slice("/shared/".length)}`;
  else if (raw === "/shared") raw = "shared";
  return raw.replace(/^\/+/, "");
}

function uniqueArtifacts(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const artifact of artifacts) {
    const keys = [artifact.id, artifactPathKey(artifact.path)].filter(Boolean) as string[];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push(artifact);
  }
  return out;
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
  const previewableArtifacts = uniqueArtifacts(
    artifacts.filter((artifact) => !hiddenSegment(artifact.path || "")),
  );
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
            className="group lift-hover flex w-full max-w-[45rem] items-center gap-3 rounded-card border border-scout-hairline-faint bg-scout-card-lavender px-3.5 py-3 text-left transition-colors hover:bg-scout-card-lavender-hover"
          >
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-btn border border-scout-hairline-faint bg-scout-lavender-muted">
              {artifact.renderer === "image" ? (
                <AuthenticatedImage
                  src={`${baseUrl}/artifacts/content?path=${encodeURIComponent(artifact.path)}`}
                  token={token}
                  alt={artifact.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <>
                  <Icon size={18} style={{ color: "#a78bfa" }} className="relative" />
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
              <span className="inline-flex rounded-btn px-2.5 py-1.5 text-xs font-semibold text-scout-muted transition-colors group-hover:bg-scout-lavender-muted group-hover:text-scout-text">
                Open
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
