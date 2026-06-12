interface StreamingIndicatorProps {
  currentTool: string | undefined;
  text: string;
}

export function StreamingIndicator({
  currentTool,
  text,
}: StreamingIndicatorProps) {
  return (
    <div className="flex items-center gap-2 py-2">
      <div className="flex space-x-1">
        <div className="w-1.5 h-1.5 rounded-full bg-scout-text thinking-dot" />
        <div className="w-1.5 h-1.5 rounded-full bg-scout-text thinking-dot" />
        <div className="w-1.5 h-1.5 rounded-full bg-scout-text thinking-dot" />
      </div>
      <span className="text-sm text-scout-muted">
        {text
          ? currentTool
            ? `Running ${currentTool}...`
            : "Writing..."
          : currentTool
            ? `Running ${currentTool}...`
            : "Thinking..."}
      </span>
    </div>
  );
}
