import { Brain, ChevronRight } from "lucide-react";

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
      className={`inline-flex items-center gap-2 rounded-pill bg-scout-card-amber border border-scout-hairline-faint px-3 py-1.5 text-left hover:bg-scout-card-amber-hover transition-colors ${className}`}
      title="Open memories"
    >
      <Brain size={15} className="shrink-0 text-[#f5c542]" />
      <span className="text-[13px] text-scout-text truncate">Memory updated</span>
      <ChevronRight size={13} className="text-scout-muted shrink-0" />
    </button>
  );
}
