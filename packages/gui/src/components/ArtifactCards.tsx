import type { Artifact } from "scout-core";
import { Brain, FileCode2, Image, FileText, Table2, ExternalLink } from "lucide-react";

function hiddenSegment(path: string) {
  return path.split("/").some((part) => part.startsWith("."));
}

function isMemoryArtifact(artifact: Artifact) {
  const path = artifact.path || "";
  return path.includes(".scout/memories/") || /(^|\/)(MEMORY|memory_summary|raw_memories)\.md$/.test(path);
}

export function ArtifactCards({
  artifacts,
  onOpen,
  onOpenMemories,
}: {
  artifacts: Artifact[];
  onOpen: (artifact: Artifact) => void;
  onOpenMemories?: () => void;
}) {
  const previewableArtifacts = artifacts.filter((artifact) => !hiddenSegment(artifact.path || ""));
  const hasMemoryUpdate = artifacts.some((artifact) => hiddenSegment(artifact.path || "") && isMemoryArtifact(artifact));
  if (!previewableArtifacts.length && !hasMemoryUpdate) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {hasMemoryUpdate && (
        <button
          type="button"
          onClick={onOpenMemories}
          className="flex items-center gap-2 max-w-xs rounded-xl bg-scout-panel border border-scout-hairline-faint px-3 py-2 text-left hover:bg-scout-lift transition-colors"
        >
          <Brain size={16} className="text-scout-muted shrink-0" />
          <span className="min-w-0">
            <span className="block text-xs font-normal text-scout-text truncate">
              Memory updated
            </span>
            <span className="block text-[11px] text-scout-muted truncate">
              Open memories
            </span>
          </span>
          <ExternalLink size={13} className="text-scout-muted shrink-0" />
        </button>
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
            className="flex items-center gap-2 max-w-xs rounded-xl bg-scout-panel border border-scout-hairline-faint px-3 py-2 text-left hover:bg-scout-lift transition-colors"
          >
            <Icon size={16} className="text-scout-muted shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-normal text-scout-text truncate">
                {artifact.title}
              </span>
              <span className="block text-[11px] text-scout-muted truncate">
                {artifact.name}
              </span>
            </span>
            <ExternalLink size={13} className="text-scout-muted shrink-0" />
          </button>
        );
      })}
    </div>
  );
}
