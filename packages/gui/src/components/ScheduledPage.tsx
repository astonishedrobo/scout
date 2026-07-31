import { useMemo, useState, type ReactNode } from "react";
import { Pause, Play, Trash2, Check, PlayCircle } from "lucide-react";
import type { ScheduledTask } from "../hooks/useScheduledTasks";
import { IconButton } from "./ui/IconButton";
import { EmptyState } from "./ui/EmptyState";
import { Skeleton } from "./ui/Skeleton";
import { ConfirmDialog } from "./ui/ConfirmDialog";

interface ScheduledPageProps {
  tasks: ScheduledTask[];
  activeCount: number;
  maxActive: number;
  loading: boolean;
  error: string | null;
  localTimezone: string;
  localTimezoneLabel: string;
  composer: ReactNode;
  onOpenTask: (task: ScheduledTask) => void;
  onPause: (taskId: string) => Promise<void>;
  onResume: (taskId: string) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onRunNow: (taskId: string) => Promise<void>;
}

function scheduleKindLabel(task: ScheduledTask): string {
  const kind = task.schedule?.kind;
  if (kind === "daily") return "Daily";
  if (kind === "weekly") return "Weekly";
  if (kind === "interval") return "Recurring";
  if (kind === "once") return "Once";
  return "Scheduled";
}

function lastIssuePrefix(task: ScheduledTask): string {
  if (!task.last_error) return "";
  return /missed/i.test(task.last_error) ? "Missed last run · " : "Last run failed · ";
}

function activeSubtitle(task: ScheduledTask, timeZone: string): string {
  if (task.status === "paused") return "Paused";
  const kind = scheduleKindLabel(task);
  const failPrefix = lastIssuePrefix(task);
  if (!task.next_run_at) return `${failPrefix}${kind}`.trim();
  const next = new Date(task.next_run_at);
  if (Number.isNaN(next.getTime())) return `${failPrefix}${kind}`.trim();
  const diffMs = next.getTime() - Date.now();
  if (diffMs <= 60_000) return `${failPrefix}${kind} · Running now`;
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 1) {
    const mins = Math.max(1, Math.round(diffMs / 60_000));
    return `${failPrefix}${kind} · Next run in ${mins} min`;
  }
  if (hours < 48) {
    return `${failPrefix}${kind} · Next run in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  try {
    const when = next.toLocaleString(undefined, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return `${failPrefix}${kind} · ${when}`;
  } catch {
    return `${failPrefix}${kind}`.trim();
  }
}

function completedSubtitle(task: ScheduledTask, timeZone: string): string {
  if (task.status === "failed") return "Failed";
  if (!task.last_run_at) return "Completed";
  const last = new Date(task.last_run_at);
  if (Number.isNaN(last.getTime())) return "Completed";
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (last.getTime() >= startOfToday.getTime()) return "Completed · Last run Today";
  try {
    const when = last.toLocaleDateString(undefined, {
      timeZone,
      month: "short",
      day: "numeric",
    });
    return `Completed · Last run ${when}`;
  } catch {
    return "Completed";
  }
}

/** Empty active ring: real dots via SVG dash (CSS border-dotted is unreadable at 18px). */
function DottedCircle({ failed }: { failed: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={`shrink-0 ${failed ? "text-scout-error/80" : "text-scout-muted/70"}`}
      aria-hidden
    >
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        // Short dashes + gaps → readable dots around the ring
        strokeDasharray="0.01 3.4"
      />
    </svg>
  );
}

/** Status mark: active = dotted ring; last fail = red dotted; done ok = check; done fail = red check. */
function TaskStatusMark({
  task,
  completed,
}: {
  task: ScheduledTask;
  completed: boolean;
}) {
  const failedOnce = completed && task.status === "failed";
  const lastRunFailed = !completed && Boolean(task.last_error);

  if (completed) {
    return (
      <span
        className={
          failedOnce
            ? "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-scout-error/40 bg-scout-error-muted text-scout-error/85"
            : "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-scout-muted/40 text-scout-muted"
        }
        aria-hidden
        title={failedOnce ? "Failed" : "Completed"}
      >
        <Check size={11} strokeWidth={2.5} />
      </span>
    );
  }

  // Live / paused: dotted circle. Red dots while last fire failed/missed (clears on next success).
  const issueTitle =
    lastRunFailed && task.last_error && /missed/i.test(task.last_error)
      ? "Missed last run"
      : lastRunFailed
        ? "Last run failed"
        : undefined;
  return (
    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center" title={issueTitle}>
      <DottedCircle failed={lastRunFailed} />
    </span>
  );
}

function TaskRow({
  task,
  timeZone,
  completed,
  onOpen,
  onPause,
  onResume,
  onDelete,
  onRunNow,
}: {
  task: ScheduledTask;
  timeZone: string;
  completed: boolean;
  onOpen: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}) {
  const subtitle = completed
    ? completedSubtitle(task, timeZone)
    : activeSubtitle(task, timeZone);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer items-center gap-3 rounded-btn px-3 py-2.5 text-left transition-colors hover:bg-scout-lift/65"
    >
      <TaskStatusMark task={task} completed={completed} />

      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-label font-medium tracking-[-0.01em] ${
            completed ? "text-scout-muted" : "text-scout-text"
          }`}
        >
          {task.title}
        </p>
        <p
          className={`mt-0.5 truncate text-caption ${
            (completed && task.status === "failed") || (!completed && task.last_error)
              ? "text-scout-error/75"
              : "text-scout-muted"
          }`}
        >
          {subtitle}
        </p>
      </div>

      <div
        className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {!completed && (
          <>
            <IconButton
              label="Run now"
              onClick={(e) => {
                e.stopPropagation();
                onRunNow();
              }}
            >
              <PlayCircle size={15} />
            </IconButton>
            {task.status === "active" ? (
              <IconButton
                label="Pause"
                onClick={(e) => {
                  e.stopPropagation();
                  onPause();
                }}
              >
                <Pause size={15} />
              </IconButton>
            ) : task.status === "paused" ? (
              <IconButton
                label="Resume"
                onClick={(e) => {
                  e.stopPropagation();
                  onResume();
                }}
              >
                <Play size={15} />
              </IconButton>
            ) : null}
          </>
        )}
        <IconButton
          label="Delete task"
          tone="danger"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}

export function ScheduledPage({
  tasks,
  activeCount,
  maxActive,
  loading,
  error,
  localTimezoneLabel,
  composer,
  onOpenTask,
  onPause,
  onResume,
  onDelete,
  onRunNow,
}: ScheduledPageProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("all");

  const { live, done } = useMemo(() => {
    const liveTasks = tasks.filter((t) => t.status === "active" || t.status === "paused");
    const doneTasks = tasks.filter((t) => t.status === "completed" || t.status === "failed");
    return { live: liveTasks, done: doneTasks };
  }, [tasks]);

  const showDone = filter === "all";
  const empty = live.length === 0 && (!showDone || done.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="thread-pad mx-auto w-full max-w-[46rem] px-4">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-display text-[1.35rem] font-semibold tracking-[-0.03em] text-scout-text sm:text-[1.5rem]">
                Scheduled
              </h1>
              <p className="mt-1.5 text-label leading-relaxed text-scout-muted">
                Schedule tasks, set reminders, or monitor for updates.
                <span className="text-scout-muted/70"> · {localTimezoneLabel}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFilter((f) => (f === "active" ? "all" : "active"))}
              className="shrink-0 rounded-full border border-scout-hairline-faint px-3 py-1 text-caption font-medium text-scout-muted transition-colors hover:border-scout-hairline hover:text-scout-text"
            >
              {filter === "all" ? "All" : "Active"} · {activeCount}/{maxActive}
            </button>
          </div>

          {(error || actionError) && (
            <div className="mb-4 rounded-btn border border-scout-error/20 bg-scout-error-muted px-3 py-2.5 text-label text-scout-error">
              {actionError || error}
            </div>
          )}

          {loading && empty ? (
            <Skeleton.List rows={5} />
          ) : empty ? (
            <EmptyState
              title="No scheduled tasks yet"
              body="Describe a reminder or recurring job below. Each task keeps its own thread."
              className="py-14"
            />
          ) : (
            <div className="pb-2">
              {live.length > 0 && (
                <div className="density-list">
                  {live.map((task) => (
                    <TaskRow
                      key={task.task_id}
                      task={task}
                      timeZone={task.timezone || "UTC"}
                      completed={false}
                      onOpen={() => onOpenTask(task)}
                      onPause={() => {
                        void onPause(task.task_id).catch((err) =>
                          setActionError(err instanceof Error ? err.message : "Pause failed"),
                        );
                      }}
                      onResume={() => {
                        void onResume(task.task_id).catch((err) =>
                          setActionError(err instanceof Error ? err.message : "Resume failed"),
                        );
                      }}
                      onDelete={() => setDeleteTarget(task)}
                      onRunNow={() => {
                        void onRunNow(task.task_id).catch((err) =>
                          setActionError(err instanceof Error ? err.message : "Run failed"),
                        );
                      }}
                    />
                  ))}
                </div>
              )}

              {showDone && done.length > 0 && (
                <>
                  {live.length > 0 && (
                    <div className="my-2 border-t border-dashed border-scout-hairline" aria-hidden />
                  )}
                  <div className="density-list">
                    {done.map((task) => (
                      <TaskRow
                        key={task.task_id}
                        task={task}
                        timeZone={task.timezone || "UTC"}
                        completed
                        onOpen={() => onOpenTask(task)}
                        onPause={() => {}}
                        onResume={() => {}}
                        onDelete={() => setDeleteTarget(task)}
                        onRunNow={() => {}}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Same footer shell as normal chat threads */}
      <div className="shrink-0 bg-scout-canvas/95">{composer}</div>

      <ConfirmDialog
        request={
          deleteTarget
            ? {
                title: "Delete scheduled task",
                body: `Delete “${deleteTarget.title}”? Empty task chats are removed; chats with history are kept.`,
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: () => {
                  const id = deleteTarget.task_id;
                  setDeleteTarget(null);
                  return onDelete(id).catch((err) =>
                    setActionError(err instanceof Error ? err.message : "Delete failed"),
                  );
                },
              }
            : null
        }
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
