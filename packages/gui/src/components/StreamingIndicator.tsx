interface StreamingIndicatorProps {
  currentTool: string | undefined;
  text: string;
  statusMessage?: string;
  hasToolSteps?: boolean;
}

function humanToolName(name: string) {
  switch (name) {
    case "write_file":
    case "write_binary_artifact":
      return "Creating file";
    case "apply_patch":
      return "Updating files";
    case "read_file":
      return "Reading file";
    case "list_files":
      return "Checking files";
    case "search_documents":
      return "Searching documents";
    case "read_pdf":
      return "Reading PDF";
    case "exec_command":
      return "Running command";
    case "run_python":
    case "run_code":
      return "Running Python";
    case "run_node":
      return "Running JavaScript";
    default:
      return "Working";
  }
}

export function StreamingIndicator({
  currentTool,
  text,
  statusMessage,
  hasToolSteps,
}: StreamingIndicatorProps) {
  const label = text
    ? currentTool
      ? `${humanToolName(currentTool)}...`
      : "Writing..."
    : currentTool
      ? `${humanToolName(currentTool)}...`
      : statusMessage
        ? `${statusMessage}...`
        : hasToolSteps
          ? "Preparing response..."
          : "Thinking...";

  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="flex space-x-1">
        <div className="w-1.5 h-1.5 rounded-full bg-scout-muted thinking-dot" />
        <div className="w-1.5 h-1.5 rounded-full bg-scout-muted thinking-dot" />
        <div className="w-1.5 h-1.5 rounded-full bg-scout-muted thinking-dot" />
      </div>
      <span className="text-xs text-scout-muted">{label}</span>
    </div>
  );
}
