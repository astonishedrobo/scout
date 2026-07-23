import { useEffect, useState } from "react";
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
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const activeKey = currentTool || statusMessage || "";

  useEffect(() => {
    if (!activeKey) {
      setStartedAt(null);
      return;
    }
    const started = Date.now();
    setStartedAt(started);
    setNow(started);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeKey]);

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
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  const label = elapsed === null
    ? `${rawLabel.replace(/[.…]+$/u, "")}…`
    : `${rawLabel.replace(/[.…]+$/u, "")} · ${elapsed}s`;
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
