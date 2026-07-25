import { useEffect, useState } from "react";
import { ActivityOrb } from "./ActivityOrb";

interface StreamingIndicatorProps {
  currentTool: string | undefined;
  text: string;
  statusMessage?: string;
  hasToolSteps?: boolean;
  startedAt?: number | null;
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
  startedAt,
}: StreamingIndicatorProps) {
  const [fallbackStartedAt, setFallbackStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const active = !!(currentTool || statusMessage);

  useEffect(() => {
    if (!active) {
      setFallbackStartedAt(null);
      return;
    }
    const current = Date.now();
    setFallbackStartedAt((existing) => existing ?? current);
    setNow(current);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

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
  const effectiveStartedAt = startedAt ?? fallbackStartedAt;
  const elapsed = effectiveStartedAt
    ? Math.max(0, Math.floor((now - effectiveStartedAt) / 1000))
    : null;
  const label = elapsed === null
    ? `${rawLabel.replace(/[.…]+$/u, "")}…`
    : `${rawLabel.replace(/[.…]+$/u, "")} · ${elapsed}s`;

  return (
    <div className="flex items-center gap-2 py-1.5">
      <ActivityOrb />
      <span className="text-label text-scout-muted">{label}</span>
    </div>
  );
}
