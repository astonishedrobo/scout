import { Brain, ExternalLink } from "lucide-react";

export function MemoryUpdateChip({
  onOpenMemories,
  className = "",
}: {
  onOpenMemories?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpenMemories}
      className={`flex items-center gap-2 max-w-xs rounded-xl bg-scout-panel border border-scout-hairline-faint px-3 py-2 text-left hover:bg-scout-lift transition-colors ${className}`}
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
  );
}
