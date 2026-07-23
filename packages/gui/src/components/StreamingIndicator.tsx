import { ActivityOrb, activityForTool } from "./ActivityOrb";

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
    case "search_workspace":
      return "Searching workspace";
    case "filter_table":
      return "Filtering table";
    case "exec_command":
      return "Running command";
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
  // Once prose is visibly streaming, the text itself is the progress signal.
  if (text && !currentTool) return null;

  const rawLabel = text
    ? humanToolName(currentTool!)
    : currentTool
      ? humanToolName(currentTool)
      : statusMessage
        ? statusMessage
        : hasToolSteps
          ? "Preparing response"
          : "Starting";
  const label = `${rawLabel.replace(/[.…]+$/u, "")}…`;
  const activity = text
    ? "composing"
    : currentTool
      ? activityForTool(currentTool)
      : hasToolSteps
        ? "solving"
        : "listening";

  return (
    <div className="flex items-center gap-2 py-1.5">
      <ActivityOrb activity={activity} label={label} />
      <span className="text-[13px] text-scout-muted">{label}</span>
    </div>
  );
}
