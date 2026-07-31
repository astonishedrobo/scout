import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ScheduleKind = "once" | "interval" | "daily" | "weekly";

export interface ScheduleSpec {
  kind: ScheduleKind;
  timezone: string;
  run_at?: string | null;
  interval_minutes?: number | null;
  time?: string | null;
  weekdays?: number[] | null;
}

/** Browser IANA zone (e.g. Asia/Kolkata) from the machine that opened the app. */
export function detectLocalTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || typeof zone !== "string") {
    throw new Error("Could not detect local timezone from this browser");
  }
  return zone;
}

/** e.g. "Asia/Kolkata (GMT+5:30)" for UI labels. */
export function formatTimezoneLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(at);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value;
    if (offset) return `${timeZone} (${offset})`;
  } catch {
    /* fall through */
  }
  return timeZone;
}

export interface ScheduledTask {
  task_id: string;
  user_id: string;
  title: string;
  instruction: string;
  schedule: ScheduleSpec;
  schedule_label: string;
  timezone: string;
  status: "active" | "paused" | "completed" | "failed";
  session_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
  run_count: number;
}

export interface CreateScheduledTaskInput {
  text?: string;
  instruction?: string;
  title?: string;
  schedule?: ScheduleSpec;
  timezone?: string;
  status?: "active" | "paused";
}

interface UseScheduledTasksReturn {
  tasks: ScheduledTask[];
  activeCount: number;
  maxActive: number;
  loading: boolean;
  error: string | null;
  /** IANA zone of this browser/session — used for new tasks. */
  localTimezone: string;
  localTimezoneLabel: string;
  refresh: () => Promise<void>;
  createTask: (input: CreateScheduledTaskInput) => Promise<ScheduledTask>;
  updateTask: (
    taskId: string,
    patch: Partial<Pick<ScheduledTask, "title" | "instruction" | "status">> & {
      schedule?: ScheduleSpec;
    },
  ) => Promise<ScheduledTask>;
  deleteTask: (taskId: string) => Promise<void>;
  runTaskNow: (taskId: string) => Promise<ScheduledTask>;
  pauseTask: (taskId: string) => Promise<ScheduledTask>;
  resumeTask: (taskId: string) => Promise<ScheduledTask>;
}

export function useScheduledTasks(
  baseUrl: string,
  isReady: boolean,
  token: string | null,
  isMultiUser: boolean | undefined,
  enabled: boolean,
): UseScheduledTasksReturn {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [maxActive, setMaxActive] = useState(15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const localTimezone = useMemo(() => detectLocalTimezone(), []);
  const localTimezoneLabel = useMemo(
    () => formatTimezoneLabel(localTimezone),
    [localTimezone],
  );

  const headers = useCallback((): HeadersInit => {
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, [token]);

  const refresh = useCallback(async () => {
    if (!baseUrl || (isMultiUser && !token)) return;
    try {
      const resp = await fetch(`${baseUrl}/scheduled-tasks`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.detail || `Failed to load scheduled tasks (${resp.status})`);
      }
      const data = await resp.json();
      setTasks(data.tasks ?? []);
      setActiveCount(data.active_count ?? 0);
      setMaxActive(data.max_active ?? 15);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scheduled tasks");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, token, isMultiUser]);

  useEffect(() => {
    if (!isReady || !enabled) return;
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 15_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isReady, enabled, refresh]);

  const createTask = useCallback(
    async (input: CreateScheduledTaskInput): Promise<ScheduledTask> => {
      // Always stamp the opener's zone. Structured schedules inherit it when
      // the caller omits schedule.timezone.
      const timezone = input.timezone || localTimezone;
      const schedule = input.schedule
        ? { ...input.schedule, timezone: input.schedule.timezone || timezone }
        : undefined;
      const resp = await fetch(`${baseUrl}/scheduled-tasks`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...input, timezone, schedule }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(
          typeof body.detail === "string" ? body.detail : "Could not create scheduled task",
        );
      }
      const data = await resp.json();
      await refresh();
      return data.task as ScheduledTask;
    },
    [baseUrl, headers, refresh, localTimezone],
  );

  const updateTask = useCallback(
    async (
      taskId: string,
      patch: Partial<Pick<ScheduledTask, "title" | "instruction" | "status">> & {
        schedule?: ScheduleSpec;
      },
    ): Promise<ScheduledTask> => {
      const resp = await fetch(`${baseUrl}/scheduled-tasks/${taskId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(
          typeof body.detail === "string" ? body.detail : "Could not update scheduled task",
        );
      }
      const data = await resp.json();
      await refresh();
      return data.task as ScheduledTask;
    },
    [baseUrl, headers, refresh],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      const resp = await fetch(`${baseUrl}/scheduled-tasks/${taskId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(
          typeof body.detail === "string" ? body.detail : "Could not delete scheduled task",
        );
      }
      await refresh();
    },
    [baseUrl, token, refresh],
  );

  const runTaskNow = useCallback(
    async (taskId: string): Promise<ScheduledTask> => {
      const resp = await fetch(`${baseUrl}/scheduled-tasks/${taskId}/run`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(
          typeof body.detail === "string" ? body.detail : "Could not run scheduled task",
        );
      }
      const data = await resp.json();
      await refresh();
      return data.task as ScheduledTask;
    },
    [baseUrl, token, refresh],
  );

  const pauseTask = useCallback(
    (taskId: string) => updateTask(taskId, { status: "paused" }),
    [updateTask],
  );

  const resumeTask = useCallback(
    (taskId: string) => updateTask(taskId, { status: "active" }),
    [updateTask],
  );

  return {
    tasks,
    activeCount,
    maxActive,
    loading,
    error,
    localTimezone,
    localTimezoneLabel,
    refresh,
    createTask,
    updateTask,
    deleteTask,
    runTaskNow,
    pauseTask,
    resumeTask,
  };
}
