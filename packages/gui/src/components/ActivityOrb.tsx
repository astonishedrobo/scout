import { ThinkingOrb, type OrbState } from "thinking-orbs";

export type ScoutActivity =
  | "listening"
  | "searching"
  | "working"
  | "composing"
  | "solving";

export function activityForTool(tool?: string): ScoutActivity {
  if (!tool) return "listening";
  if (
    tool === "read_file"
    || tool === "list_files"
    || tool === "search_workspace"
    || tool === "filter_table"
  ) {
    return "searching";
  }
  if (tool === "think") return "solving";
  return "working";
}

export function ActivityOrb({
  activity: _activity,
  label,
  className = "",
}: {
  activity: ScoutActivity;
  label: string;
  className?: string;
}) {
  return (
    <ThinkingOrb
      // A single calm visual language reads faster than a different animated
      // orb for every tool. Text still says what Scout is doing.
      state={"listening" as OrbState}
      size={20}
      theme="auto"
      aria-label={label}
      className={`shrink-0 ${className}`}
    />
  );
}
