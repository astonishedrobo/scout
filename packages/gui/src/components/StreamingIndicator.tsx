interface StreamingIndicatorProps {
  currentTool: string | undefined;
  text: string;
}

export function StreamingIndicator({
  currentTool,
  text,
}: StreamingIndicatorProps) {
  if (text) return null;

  return (
    <div className="flex items-center gap-2 py-2">
      <div className="flex space-x-1">
        <div className="w-1.5 h-1.5 rounded-full bg-scout-accent thinking-dot" />
        <div className="w-1.5 h-1.5 rounded-full bg-scout-accent thinking-dot" />
        <div className="w-1.5 h-1.5 rounded-full bg-scout-accent thinking-dot" />
      </div>
      <span className="text-sm text-scout-text-secondary">
        {currentTool ? `Running ${currentTool}` : "Thinking"}...
      </span>
    </div>
  );
}
