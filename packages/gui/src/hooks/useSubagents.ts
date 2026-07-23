import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, FileChangeSet, TaskEvent } from "scout-core";

export type SubAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "expired";

export interface SubAgentEvent {
  type: string;
  ts?: number;
  agent_id?: string;
  name?: string;
  args?: Record<string, unknown>;
  output?: string;
  content?: string;
  title?: string;
  status?: string;
  last_activity?: string;
  summary?: string;
  result_preview?: string;
  result?: string;
  description?: string;
  agent_type?: string;
  color?: string;
  source?: string;
  preview?: string;
  final?: boolean;
  artifacts?: Artifact[];
  file_changes?: FileChangeSet[];
  [key: string]: unknown;
}

export interface SubAgentInfo {
  agent_id: string;
  description: string;
  agent_type: string;
  color: string;
  status: SubAgentStatus;
  background?: boolean;
  created_at?: number;
  finished_at?: number | null;
  tool_use_count?: number;
  last_activity?: string;
  summary?: string;
  result?: string;
  result_preview?: string;
  error?: string;
  events?: SubAgentEvent[];
  retain_open?: boolean;
  evict_after?: number | null;
  can_message?: boolean;
}

export interface AgentFinishedNotice {
  agent_id: string;
  description: string;
  status: string;
  summary: string;
  result_preview?: string;
}

const COLOR_MAP: Record<string, string> = {
  rose: "#f43f5e",
  emerald: "#10b981",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  sky: "#0ea5e9",
  fuchsia: "#d946ef",
};

export function subagentColor(color?: string): string {
  return COLOR_MAP[color || "emerald"] || COLOR_MAP.emerald;
}

function eventKey(ev: SubAgentEvent): string {
  return [
    ev.type || "",
    ev.ts ?? "",
    ev.agent_id || "",
    ev.tool_call_id || "",
    ev.name || "",
    (ev.content || ev.preview || ev.output || "").toString().slice(0, 40),
  ].join("|");
}

function mergeEvents(
  existing: SubAgentEvent[] | undefined,
  incoming: SubAgentEvent[] | undefined,
): SubAgentEvent[] {
  const out: SubAgentEvent[] = [];
  const seen = new Set<string>();
  for (const ev of [...(existing || []), ...(incoming || [])]) {
    const k = eventKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

interface UseSubagentsOptions {
  baseUrl: string;
  sessionId: string | null;
  token: string | null;
  enabled?: boolean;
  onApprovalEvent?: (event: Record<string, unknown>) => void;
  /** Claude/Codex-style: parent finished integrating a worker result into main chat. */
  onParentAutoReply?: (content: string) => void;
  onParentAutoResponseStart?: () => void;
  onParentAutoResponseDelta?: (content: string) => void;
  /** Toast / inline notice when a worker finishes. */
  onAgentFinished?: (notice: AgentFinishedNotice) => void;
  onParentAutoTurnStarted?: () => void;
  onParentAutoTurnFinished?: () => void;
  /** Durable lifecycle event rendered inline in the parent conversation. */
  onTaskEvent?: (event: TaskEvent) => void;
}

export function useSubagents({
  baseUrl,
  sessionId,
  token,
  enabled = true,
  onApprovalEvent,
  onParentAutoReply,
  onParentAutoResponseStart,
  onParentAutoResponseDelta,
  onAgentFinished,
  onParentAutoTurnStarted,
  onParentAutoTurnFinished,
  onTaskEvent,
}: UseSubagentsOptions) {
  const [agents, setAgents] = useState<SubAgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubAgentInfo | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [finishedNotices, setFinishedNotices] = useState<AgentFinishedNotice[]>([]);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const detailEventsLenRef = useRef(0);
  const lastEventIdRef = useRef(0);
  const onApprovalRef = useRef(onApprovalEvent);
  const onParentAutoReplyRef = useRef(onParentAutoReply);
  const onParentAutoResponseStartRef = useRef(onParentAutoResponseStart);
  const onParentAutoResponseDeltaRef = useRef(onParentAutoResponseDelta);
  const onAgentFinishedRef = useRef(onAgentFinished);
  const onParentAutoTurnStartedRef = useRef(onParentAutoTurnStarted);
  const onParentAutoTurnFinishedRef = useRef(onParentAutoTurnFinished);
  const onTaskEventRef = useRef(onTaskEvent);
  onApprovalRef.current = onApprovalEvent;
  onParentAutoReplyRef.current = onParentAutoReply;
  onParentAutoResponseStartRef.current = onParentAutoResponseStart;
  onParentAutoResponseDeltaRef.current = onParentAutoResponseDelta;
  onAgentFinishedRef.current = onAgentFinished;
  onParentAutoTurnStartedRef.current = onParentAutoTurnStarted;
  onParentAutoTurnFinishedRef.current = onParentAutoTurnFinished;
  onTaskEventRef.current = onTaskEvent;

  useEffect(() => {
    selectedIdRef.current = null;
    setAgents([]);
    setSelectedId(null);
    setDetail(null);
    setFinishedNotices([]);
    setConnected(false);
    lastEventIdRef.current = 0;
  }, [sessionId]);

  const authHeaders = useCallback((): HeadersInit => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  const upsertAgent = useCallback((patch: Partial<SubAgentInfo> & { agent_id: string }) => {
    setAgents((prev) => {
      const idx = prev.findIndex((a) => a.agent_id === patch.agent_id);
      if (idx < 0) {
        return [
          ...prev,
          {
            description: patch.description || patch.agent_id,
            agent_type: patch.agent_type || "trailhand",
            color: patch.color || "emerald",
            status: (patch.status as SubAgentStatus) || "pending",
            ...patch,
            agent_id: patch.agent_id,
          },
        ];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next.filter((a) => a.status !== "expired");
    });
  }, []);

  const appendDetailEvent = useCallback((agentId: string, event: SubAgentEvent, extra?: Partial<SubAgentInfo>) => {
    if (selectedIdRef.current !== agentId) return;
    setDetail((prev) => {
      if (!prev || prev.agent_id !== agentId) {
        // Detail not loaded yet — seed from the live event so text isn't blank.
        return {
          agent_id: agentId,
          description: String(event.description || agentId),
          agent_type: String(event.agent_type || "trailhand"),
          color: String(event.color || "emerald"),
          status: (extra?.status as SubAgentStatus) || "running",
          events: [event],
          last_activity: extra?.last_activity || event.last_activity || event.title,
          result: extra?.result || (event.final ? String(event.content || "") : undefined),
          ...extra,
        };
      }
      const events = mergeEvents(prev.events, [event]);
      detailEventsLenRef.current = events.length;
      return {
        ...prev,
        ...extra,
        events,
        last_activity: extra?.last_activity || event.last_activity || prev.last_activity,
        result:
          extra?.result ||
          (event.type === "subagent_text" && event.content
            ? String(event.content)
            : prev.result),
      };
    });
  }, []);

  const refreshList = useCallback(async () => {
    if (!baseUrl || !sessionId) return;
    try {
      const resp = await fetch(`${baseUrl}/sessions/${sessionId}/subagents`, {
        headers: authHeaders(),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      setAgents((data.subagents || []) as SubAgentInfo[]);
    } catch {
      /* ignore */
    }
  }, [authHeaders, baseUrl, sessionId]);

  const refreshTasks = useCallback(async () => {
    if (!baseUrl || !sessionId) return;
    try {
      const resp = await fetch(`${baseUrl}/sessions/${sessionId}/tasks`, {
        headers: authHeaders(),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      for (const task of (data.tasks || []) as TaskEvent[]) onTaskEventRef.current?.(task);
    } catch {
      /* A task snapshot is a recovery path; the live event stream remains primary. */
    }
  }, [authHeaders, baseUrl, sessionId]);

  const loadDetail = useCallback(
    async (agentId: string) => {
      if (!baseUrl || !sessionId) return;
      try {
        const resp = await fetch(
          `${baseUrl}/sessions/${sessionId}/subagents/${agentId}`,
          { headers: authHeaders() },
        );
        if (!resp.ok) return;
        const data = await resp.json();
        const remote = data.subagent as SubAgentInfo;
        setDetail((prev) => {
          if (prev && prev.agent_id === agentId) {
            const events = mergeEvents(prev.events, remote.events);
            // Prefer whichever side has more timeline richness.
            if ((prev.events?.length || 0) > (remote.events?.length || 0) + 2) {
              return {
                ...remote,
                ...prev,
                events,
                result: prev.result || remote.result,
                summary: remote.summary || prev.summary,
                status: remote.status || prev.status,
              };
            }
            return {
              ...prev,
              ...remote,
              events,
              result: remote.result || prev.result,
            };
          }
          return remote;
        });
      } catch {
        /* ignore */
      }
    },
    [authHeaders, baseUrl, sessionId],
  );

  const selectAgent = useCallback(
    async (agentId: string | null) => {
      setSelectedId(agentId);
      selectedIdRef.current = agentId;
      if (!agentId) {
        setDetail(null);
        return;
      }
      setPanelOpen(true);
      // Optimistic seed from list so the panel isn't empty while fetching.
      setAgents((prev) => {
        const found = prev.find((a) => a.agent_id === agentId);
        if (found) {
          setDetail((d) =>
            d?.agent_id === agentId
              ? d
              : { ...found, events: d?.events || found.events || [] },
          );
        }
        return prev;
      });
      await loadDetail(agentId);
      if (baseUrl && sessionId) {
        void fetch(`${baseUrl}/sessions/${sessionId}/subagents/${agentId}/retain`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ retain: true }),
        });
      }
    },
    [authHeaders, baseUrl, loadDetail, sessionId],
  );

  const clearSelection = useCallback(async () => {
    const id = selectedIdRef.current;
    if (id && baseUrl && sessionId) {
      void fetch(`${baseUrl}/sessions/${sessionId}/subagents/${id}/retain`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ retain: false }),
      });
    }
    setSelectedId(null);
    selectedIdRef.current = null;
    setDetail(null);
  }, [authHeaders, baseUrl, sessionId]);

  const sendMessage = useCallback(
    async (agentId: string, message: string) => {
      if (!baseUrl || !sessionId) return;
      const resp = await fetch(
        `${baseUrl}/sessions/${sessionId}/subagents/${agentId}/message`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `Send failed (${resp.status})`);
      }
      // Don't hard-replace detail — live SSE will stream the follow-up.
      void loadDetail(agentId);
    },
    [authHeaders, baseUrl, loadDetail, sessionId],
  );

  const stopAgent = useCallback(
    async (agentId: string) => {
      if (!baseUrl || !sessionId) return;
      await fetch(`${baseUrl}/sessions/${sessionId}/subagents/${agentId}/stop`, {
        method: "POST",
        headers: authHeaders(),
      });
      await refreshList();
      if (selectedIdRef.current === agentId) await loadDetail(agentId);
    },
    [authHeaders, baseUrl, loadDetail, refreshList, sessionId],
  );

  const dismissFinishedNotice = useCallback((agentId: string) => {
    setFinishedNotices((prev) => prev.filter((n) => n.agent_id !== agentId));
  }, []);

  // SSE subscription
  useEffect(() => {
    if (!enabled || !baseUrl || !sessionId) {
      setAgents([]);
      setConnected(false);
      return;
    }

    const url = new URL(`${baseUrl}/sessions/${sessionId}/subagent-events`);
    if (lastEventIdRef.current > 0) {
      url.searchParams.set("after", String(lastEventIdRef.current));
    }
    const controller = new AbortController();
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function run() {
      try {
        const resp = await fetch(url.toString(), {
          headers: {
            ...authHeaders(),
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          setConnected(false);
          void refreshList();
          if (!closed) {
            reconnectTimer = setTimeout(() => void run(), 2500);
          }
          return;
        }
        setConnected(true);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType = "message";
        let dataLines: string[] = [];
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n");
          buffer = chunks.pop() || "";
          for (const rawLine of chunks) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).replace(/^ /, ""));
            } else if (line === "") {
              if (dataLines.length) {
                const raw = dataLines.join("\n");
                dataLines = [];
                try {
                  const event = JSON.parse(raw) as SubAgentEvent;
                  handleEvent(event, eventType);
                } catch {
                  /* ignore */
                }
              }
              eventType = "message";
            }
          }
        }
        setConnected(false);
        if (!closed) {
          reconnectTimer = setTimeout(() => void run(), 1500);
        }
      } catch {
        if (!controller.signal.aborted) {
          setConnected(false);
          if (!closed) {
            reconnectTimer = setTimeout(() => void run(), 2500);
          }
        }
      }
    }

    function handleEvent(event: SubAgentEvent, eventType: string) {
      const type = event.type || eventType;
      if (type === "ping") return;
      const eventId = Number(event.event_id || 0);
      if (eventId && eventId <= lastEventIdRef.current) return;
      if (eventId) lastEventIdRef.current = eventId;

      if (type === "subagents_snapshot") {
        const list = (event as { subagents?: SubAgentInfo[] }).subagents || [];
        setAgents(list);
        return;
      }
      if (type === "task_event" && event.task && typeof event.task === "object") {
        const task = event.task as TaskEvent;
        onTaskEventRef.current?.(task);
        // Derive the transcript handoff from the same durable terminal event
        // that updates the task card. A separate best-effort notice must never
        // be able to leave the card finished while the main thread stays silent.
        if (
          task.task_type === "agent" &&
          ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        ) {
          onAgentFinishedRef.current?.({
            agent_id: task.task_id,
            description: task.title,
            status: task.status,
            summary: task.summary || task.error || task.status,
            result_preview: task.result_preview,
          });
        }
        return;
      }
      if (type === "approval_request" || type === "approval_cancelled") {
        onApprovalRef.current?.(event as Record<string, unknown>);
        return;
      }
      if (type === "parent_auto_reply" && event.content) {
        onParentAutoReplyRef.current?.(String(event.content));
        return;
      }
      if (type === "parent_auto_response_start") {
        onParentAutoResponseStartRef.current?.();
        return;
      }
      if (type === "parent_auto_response_delta" && event.content) {
        onParentAutoResponseDeltaRef.current?.(String(event.content));
        return;
      }
      if (type === "parent_auto_turn_started") {
        onParentAutoTurnStartedRef.current?.();
        return;
      }
      if (type === "parent_auto_turn_finished") {
        onParentAutoTurnFinishedRef.current?.();
        return;
      }
      if (type === "subagent_finished_notice") {
        const notice: AgentFinishedNotice = {
          agent_id: String(event.agent_id || ""),
          description: String(event.description || "Agent"),
          status: String(event.status || "completed"),
          summary: String(event.summary || "Finished"),
          result_preview: event.result_preview
            ? String(event.result_preview)
            : undefined,
        };
        if (notice.agent_id) {
          setFinishedNotices((prev) => {
            if (prev.some((n) => n.agent_id === notice.agent_id)) return prev;
            return [...prev, notice].slice(-6);
          });
          onAgentFinishedRef.current?.(notice);
        }
        return;
      }

      const agentId = event.agent_id;
      if (!agentId) return;

      if (type === "subagent_started") {
        upsertAgent({
          agent_id: agentId,
          description: event.description || agentId,
          agent_type: event.agent_type || "trailhand",
          color: event.color || "emerald",
          status: "pending",
          last_activity: "Starting…",
        });
        return;
      }

      if (
        type === "subagent_status" ||
        type === "subagent_tool_call" ||
        type === "subagent_tool_result" ||
        type === "subagent_thinking" ||
        type === "subagent_text" ||
        type === "subagent_response_start" ||
        type === "subagent_text_delta" ||
        type === "subagent_user_message" ||
        type === "subagent_message_queued"
      ) {
        const activity =
          type === "subagent_user_message" || type === "subagent_message_queued"
            ? "Working on follow-up…"
            : type === "subagent_response_start" || type === "subagent_text_delta"
              ? "Composing…"
            : event.last_activity || event.title || event.name;
        upsertAgent({
          agent_id: agentId,
          status: (event.status as SubAgentStatus) || "running",
          last_activity: activity ? String(activity) : "Working…",
        });
        appendDetailEvent(agentId, event, {
          status: "running",
          last_activity: activity ? String(activity) : undefined,
          result:
            type === "subagent_text" && event.content
              ? String(event.content)
              : undefined,
        });
        return;
      }

      if (
        type === "subagent_completed" ||
        type === "subagent_failed" ||
        type === "subagent_stopped"
      ) {
        const status =
          (event.status as SubAgentStatus) ||
          (type === "subagent_completed"
            ? "completed"
            : type === "subagent_failed"
              ? "failed"
              : "stopped");
        const result = event.result
          ? String(event.result)
          : event.result_preview
            ? String(event.result_preview)
            : undefined;
        upsertAgent({
          agent_id: agentId,
          status,
          summary: event.summary || status,
          result_preview: event.result_preview
            ? String(event.result_preview)
            : undefined,
          result,
          last_activity: event.summary || status,
        });
        appendDetailEvent(agentId, event, {
          status,
          summary: event.summary ? String(event.summary) : undefined,
          result,
          last_activity: event.summary ? String(event.summary) : status,
        });
        // Also surface a finished notice if auto-continue is off / delayed
        if (type === "subagent_completed" || type === "subagent_failed") {
          const notice: AgentFinishedNotice = {
            agent_id: agentId,
            description: String(event.description || "Agent"),
            status,
            summary: String(event.summary || status),
            result_preview: event.result_preview
              ? String(event.result_preview)
              : result?.slice(0, 200),
          };
          setFinishedNotices((prev) => {
            if (prev.some((n) => n.agent_id === notice.agent_id)) return prev;
            return [...prev, notice].slice(-6);
          });
        }
        return;
      }

      if (type === "subagent_expired") {
        setAgents((prev) => prev.filter((a) => a.agent_id !== agentId));
        setDetail((prev) => (prev?.agent_id === agentId ? null : prev));
        setSelectedId((id) => (id === agentId ? null : id));
        if (selectedIdRef.current === agentId) selectedIdRef.current = null;
        return;
      }

      if (type === "subagent_context_expired") {
        upsertAgent({ agent_id: agentId, can_message: false });
        if (selectedIdRef.current === agentId) {
          setDetail((prev) =>
            prev?.agent_id === agentId ? { ...prev, can_message: false } : prev,
          );
        }
      }
    }

    void run();
    void refreshList();
    void refreshTasks();

    return () => {
      closed = true;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [
    appendDetailEvent,
    authHeaders,
    baseUrl,
    enabled,
    refreshList,
    refreshTasks,
    sessionId,
    upsertAgent,
  ]);

  const hasLiveAgents = agents.some(
    (agent) => agent.status === "pending" || agent.status === "running",
  );

  // Reconcile live workers from the authoritative session snapshot.  The event
  // stream gives the panel low-latency updates, but a proxy/browser can keep a
  // stale SSE connection open after a network change.  Without this check an
  // agent that was stopped or completed by the parent chat could look "working"
  // until the page was reloaded.  Poll only while work is live, so idle chats
  // make no periodic request.
  useEffect(() => {
    if (!enabled || !sessionId || !hasLiveAgents) return;

    // Start immediately: this closes the race between a parent tool call
    // (for example stop_subagent) and its corresponding SSE lifecycle event.
    void refreshList();
    if (selectedIdRef.current) void loadDetail(selectedIdRef.current);
    const t = setInterval(() => {
      void refreshList();
      if (selectedIdRef.current) void loadDetail(selectedIdRef.current);
    }, connected ? 2000 : 1000);
    return () => clearInterval(t);
  }, [connected, enabled, hasLiveAgents, loadDetail, refreshList, sessionId]);

  // While viewing a live agent, soft-refresh detail periodically as a safety net
  useEffect(() => {
    if (!selectedId || !connected) return;
    const agent = agents.find((a) => a.agent_id === selectedId);
    if (!agent || (agent.status !== "running" && agent.status !== "pending")) {
      return;
    }
    const t = setInterval(() => void loadDetail(selectedId), 4000);
    return () => clearInterval(t);
  }, [agents, connected, loadDetail, selectedId]);

  const active = agents.filter(
    (a) => a.status === "pending" || a.status === "running",
  );
  const done = agents.filter(
    (a) =>
      a.status === "completed" ||
      a.status === "failed" ||
      a.status === "stopped",
  );

  return {
    agents,
    active,
    done,
    selectedId,
    detail,
    panelOpen,
    setPanelOpen,
    connected,
    finishedNotices,
    selectAgent,
    clearSelection,
    sendMessage,
    stopAgent,
    refreshList,
    loadDetail,
    dismissFinishedNotice,
  };
}
