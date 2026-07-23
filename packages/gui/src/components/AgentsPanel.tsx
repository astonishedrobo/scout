import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Maximize2,
  Minimize2,
  Square,
  X,
} from "lucide-react";
import type {
  Artifact,
  FileChangeSet,
  Message,
  TaskEvent,
  ToolStep,
} from "scout-core";
import type {
  SubAgentEvent,
  SubAgentInfo,
} from "../hooks/useSubagents";
import { ActivityOrb, activityForTool } from "./ActivityOrb";
import { ChatView } from "./ChatView";
import { headerIconButtonClass } from "./ui/headerControls";

interface AgentsPanelProps {
  active: SubAgentInfo[];
  done: SubAgentInfo[];
  selectedId: string | null;
  detail: SubAgentInfo | null;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  onStop: (id: string) => Promise<void>;
  onSend: (id: string, message: string) => Promise<void>;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenFileChanges?: (changeSet: FileChangeSet) => void;
  onUndoFileChanges?: (changeSet: FileChangeSet) => void;
  baseUrl?: string;
  token?: string | null;
  terminalTasks?: TaskEvent[];
}

function isLive(agent?: SubAgentInfo | null) {
  return agent?.status === "running" || agent?.status === "pending";
}

function statusLabel(status: string) {
  if (status === "running" || status === "pending") return "working";
  if (status === "completed") return "done";
  return status;
}

function elapsedLabel(start?: number, end?: number | null, now = Date.now() / 1000) {
  if (!start) return "";
  const seconds = Math.max(0, Math.floor((end ?? now) - start));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function AgentRow({
  agent,
  onClick,
}: {
  agent: SubAgentInfo;
  onClick: () => void;
}) {
  const live = isLive(agent);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const elapsed = elapsedLabel(agent.created_at, agent.finished_at, now);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-scout-lift/60"
    >
      {live ? (
        <ActivityOrb
          activity={activityForTool(
            agent.last_activity?.toLowerCase().includes("search") ? "search_workspace" : undefined,
          )}
          label={`${agent.description} is working`}
          className="-ml-1 -mt-0.5"
        />
      ) : (
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            agent.status === "failed" ? "bg-scout-error" : "bg-scout-success"
          }`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-scout-text">
            {agent.description}
          </span>
          <span className="shrink-0 text-[11px] text-scout-muted">
            {statusLabel(agent.status)}
          </span>
          {elapsed && <span className="shrink-0 text-[11px] tabular-nums text-scout-muted">{elapsed}</span>}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12px] text-scout-muted">
          {agent.summary || agent.last_activity || agent.status}
        </div>
      </div>
    </button>
  );
}

function toolStepFromEvent(event: SubAgentEvent): ToolStep {
  return {
    kind: "tool",
    name: String(event.name || "unknown"),
    args: event.args || {},
    status: "executing",
  };
}

function buildAgentChat(detail: SubAgentInfo) {
  const messages: Message[] = [];
  let steps: ToolStep[] = [];
  let text = "";
  let artifacts: Artifact[] = [];
  let fileChanges: FileChangeSet[] = [];

  const flushAssistant = () => {
    if (!text.trim() && !steps.length && !artifacts.length && !fileChanges.length) return;
    messages.push({
      role: "assistant",
      content: text,
      steps: [...steps],
      artifacts: [...artifacts],
      fileChanges: [...fileChanges],
    });
    steps = [];
    text = "";
    artifacts = [];
    fileChanges = [];
  };

  for (const event of detail.events || []) {
    const type = event.type;
    if (type === "subagent_user_message" || type === "subagent_message_queued") {
      flushAssistant();
      const content = String(event.content || event.preview || "").trim();
      if (content) messages.push({ role: "user", content });
      continue;
    }
    if (type === "subagent_response_start") {
      text = "";
      continue;
    }
    if (type === "subagent_text_delta") {
      text += String(event.content || "");
      continue;
    }
    if (type === "subagent_thinking") {
      const content = String(event.content || "").trim();
      if (content) {
        steps.push({
          kind: "thinking",
          name: "think",
          args: {},
          status: "complete",
          title: String(event.title || ""),
          content,
          reflection: content,
        });
      }
      continue;
    }
    if (type === "subagent_tool_call") {
      steps.push(toolStepFromEvent(event));
      continue;
    }
    if (type === "subagent_tool_result") {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (
          steps[i].kind === "tool"
          && steps[i].status === "executing"
          && steps[i].name === String(event.name || steps[i].name)
        ) {
          steps[i] = {
            ...steps[i],
            status: "complete",
            output: String(event.output || ""),
          };
          break;
        }
      }
      artifacts.push(...(event.artifacts || []));
      fileChanges.push(...(event.file_changes || []));
      continue;
    }
    if (type === "subagent_text" && event.content) {
      if (event.final) {
        text = String(event.content);
      } else {
        const content = String(event.content).trim();
        if (content) {
          steps.push({
            kind: "text",
            name: "text",
            args: {},
            status: "complete",
            content,
          });
        }
      }
      continue;
    }
    if (
      type === "subagent_completed"
      || type === "subagent_failed"
      || type === "subagent_stopped"
    ) {
      if (!text.trim() && event.result) text = String(event.result);
      flushAssistant();
    }
  }

  const live = isLive(detail);
  if (!live) {
    if (!text.trim() && !messages.some((message) => message.role === "assistant")) {
      text = detail.result || "";
    }
    flushAssistant();
  }

  return {
    messages,
    streamingSteps: live ? steps : [],
    streamingText: live ? text : "",
    currentTool: live
      ? [...steps].reverse().find((step) => step.status === "executing")?.name
      : undefined,
  };
}

export function AgentsPanel({
  active,
  done,
  selectedId,
  detail,
  expanded,
  onToggleExpand,
  onClose,
  onSelect,
  onBack,
  onStop,
  onSend,
  onOpenArtifact,
  onOpenFileChanges,
  onUndoFileChanges,
  baseUrl = "",
  token = null,
  terminalTasks = [],
}: AgentsPanelProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inDetail = Boolean(selectedId && detail);
  const live = isLive(detail);
  const canMessage = Boolean(
    detail && detail.status !== "expired" && detail.can_message !== false,
  );
  const chat = useMemo(
    () => (detail ? buildAgentChat(detail) : null),
    [detail],
  );

  useEffect(() => {
    setDraft("");
    setError(null);
  }, [selectedId]);

  const submit = async () => {
    if (!detail || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(detail.agent_id, draft.trim());
      setDraft("");
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-scout-canvas">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-scout-hairline-faint px-3">
        {inDetail ? (
          <button
            type="button"
            className={headerIconButtonClass}
            onClick={onBack}
            title="Back to agents"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <Bot size={16} className="text-scout-muted" />
        )}
        <div className="min-w-0 flex-1">
          <span className="truncate text-[13px] font-semibold text-scout-text">
            {inDetail ? detail!.description : "Tasks"}
          </span>
        </div>
        {inDetail && live && (
          <button
            type="button"
            className={headerIconButtonClass}
            title="Stop agent"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await onStop(detail!.agent_id);
              } finally {
                setStopping(false);
              }
            }}
          >
            <Square size={14} />
          </button>
        )}
        {onToggleExpand && (
          <button
            type="button"
            className={headerIconButtonClass}
            onClick={onToggleExpand}
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button
          type="button"
          className={headerIconButtonClass}
          onClick={onClose}
          title="Close"
        >
          <X size={16} />
        </button>
      </div>

      {!inDetail && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-scout-muted">
            Active
          </div>
          {active.length ? (
            active.map((agent) => (
              <AgentRow
                key={agent.agent_id}
                agent={agent}
                onClick={() => onSelect(agent.agent_id)}
              />
            ))
          ) : (
            <div className="px-2.5 py-2 text-[12px] text-scout-muted">
              Nothing running
            </div>
          )}
          {terminalTasks.filter((task) => task.status === "running" || task.status === "queued").map((task) => (
            <div key={task.task_id} className="flex items-start gap-2.5 rounded-xl px-2.5 py-2">
              <ActivityOrb activity="working" label={`${task.title} is running`} className="-ml-1 -mt-0.5" />
              <div className="min-w-0 flex-1"><div className="flex gap-2 text-[13px] font-medium text-scout-text"><span className="truncate">{task.title}</span><span className="text-[11px] font-normal text-scout-muted">running</span></div><div className="text-[12px] text-scout-muted">{task.summary || "Running command"}</div></div>
            </div>
          ))}
          <div className="mt-4 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-scout-muted">
            Done{done.length ? ` · ${done.length}` : ""}
          </div>
          {done.length ? (
            done.map((agent) => (
              <AgentRow
                key={agent.agent_id}
                agent={agent}
                onClick={() => onSelect(agent.agent_id)}
              />
            ))
          ) : (
            <div className="px-2.5 py-2 text-[12px] text-scout-muted">
              No finished agents yet
            </div>
          )}
          {terminalTasks.filter((task) => !["running", "queued"].includes(task.status)).map((task) => (
            <div key={task.task_id} className="flex items-start gap-2.5 rounded-xl px-2.5 py-2"><span className={`mt-1.5 h-2 w-2 rounded-full ${task.status === "failed" ? "bg-scout-error" : "bg-scout-success"}`} /><div className="min-w-0"><div className="text-[13px] font-medium text-scout-text">{task.title}</div><div className="line-clamp-2 text-[12px] text-scout-muted">{task.summary || task.result_preview || task.status}</div></div></div>
          ))}
        </div>
      )}

      {inDetail && detail && chat && (
        <>
          <ChatView
            messages={chat.messages}
            streamingSteps={chat.streamingSteps}
            streamingText={chat.streamingText}
            currentTool={chat.currentTool}
            statusMessage={detail.last_activity || "Working"}
            isLoading={live}
            onOpenArtifact={onOpenArtifact}
            onOpenFileChanges={onOpenFileChanges}
            onUndoFileChanges={onUndoFileChanges}
            baseUrl={baseUrl}
            token={token}
          />
          <div className="shrink-0 border-t border-scout-hairline-faint bg-scout-canvas/95 p-2.5">
            {error && (
              <div className="mb-1.5 text-[12px] text-scout-error">{error}</div>
            )}
            {canMessage ? (
              <div
                className={`relative flex flex-col overflow-hidden rounded-[20px] border border-scout-hairline-faint bg-scout-panel shadow-composer transition-all focus-within:border-scout-hairline focus-within:ring-1 focus-within:ring-scout-text/10 ${
                  sending ? "opacity-70" : ""
                }`}
              >
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={2}
                  placeholder={live ? "Redirect or add instructions…" : "Follow up with this agent…"}
                  className="min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] leading-relaxed text-scout-text outline-none placeholder:text-scout-muted/70"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div className="flex items-center justify-end px-2 pb-2">
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={sending || !draft.trim()}
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition active:scale-[0.98] disabled:opacity-35 ${
                      draft.trim()
                        ? "bg-scout-text text-scout-bg hover:opacity-90"
                        : "bg-scout-lift text-scout-muted"
                    }`}
                    aria-label="Send to agent"
                  >
                    <ArrowUp size={16} strokeWidth={2.4} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-scout-hairline-faint bg-scout-panel px-3 py-2 text-[12px] text-scout-muted">
                This agent’s context has expired.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function SubagentStatusStrip({
  active,
  onOpen,
}: {
  active: SubAgentInfo[];
  onOpen: () => void;
}) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!active.length) return null;
  const label =
    active.length === 1
      ? `${active[0].description} · ${active[0].last_activity || "working"}`
      : `${active.length} tasks working`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-auto mb-1 flex w-full max-w-[46rem] items-center gap-2 px-4 text-left text-[12px] text-scout-muted hover:text-scout-text"
    >
      <ActivityOrb activity="working" label={label} />
      <span className="truncate">{label}</span>
      {active.length === 1 && (
        <span className="shrink-0 tabular-nums text-scout-muted">
          {elapsedLabel(active[0].created_at, undefined, now)}
        </span>
      )}
      <span className="shrink-0 text-scout-accent">View</span>
    </button>
  );
}
