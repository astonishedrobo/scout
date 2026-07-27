import { Brain, ChevronRight } from "lucide-react";

export function MemoryUpdateChip({
  onOpenMemories,
  className = "",
}: {
  onOpenMemories?: () => void;
  className?: string;
}) {
  const base = `inline-flex items-center gap-2 rounded-pill border border-scout-hairline-faint bg-scout-card-amber px-3 py-1.5 text-left ${className}`;

  // Without a handler the chip is a label, not a control: it used to render
  // fully interactive (pointer, hover tint, tooltip) and do nothing on click.
  if (!onOpenMemories) {
    return (
      <span className={base}>
        <Brain size={15} className="shrink-0 text-scout-amber" />
        <span className="text-label text-scout-text">Memory updated</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenMemories}
      className={`${base} transition-colors hover:bg-scout-card-amber-hover`}
      title="Open memories"
    >
      <Brain size={15} className="shrink-0 text-scout-amber" />
      <span className="text-label text-scout-text">Memory updated</span>
      <ChevronRight size={13} className="shrink-0 text-scout-muted" />
    </button>
  );
}
