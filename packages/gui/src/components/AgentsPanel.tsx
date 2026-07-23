import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  Square,
  Terminal,
  X,
  Maximize2,
  Minimize2,
  Wrench,
} from "lucide-react";
import {
  subagentColor,
  type SubAgentEvent,
  type SubAgentInfo,
} from "../hooks/useSubagents";
import { headerIconButtonClass } from "./ui/headerControls";
import { MarkdownRenderer } from "./MarkdownRenderer";

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
  baseUrl?: string;
  token?: string | null;
}

function StatusDot({ status, color }: { status: string; color: string }) {
  const pulse = status === "running" || status === "pending";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${pulse ? "animate-pulse" : ""}`}
      style={{ backgroundColor: color }}
    />
  );
}

function friendlyToolLabel(
  name: string,
  args?: Record<string, unknown>,
  done = false,
): string {
  const path = String(args?.path ?? args?.directory ?? "").trim();
  const query = String(args?.query ?? "").trim();
  const file = path.split("/").filter(Boolean).pop() || path;
  switch (name) {
    case "search_workspace":
      return done
        ? query
          ? `Searched “${query.slice(0, 40)}”`
          : "Searched workspace"
        : query
          ? `Searching “${query.slice(0, 40)}”`
          : "Searching workspace";
    case "list_files":
      return done ? "Checked files" : "Checking files";
    case "read_file":
      return done
        ? `Read ${file || "a file"}`
        : `Reading ${file || "a file"}`;
    case "filter_table":
      return done ? "Filtered table" : "Filtering table";
    case "exec_command":
      return done ? "Ran command" : "Running command";
    case "run_node":
      return done ? "Ran JavaScript" : "Running JavaScript";
    case "write_file":
    case "write_binary_artifact":
      return done
        ? `Wrote ${file || "a file"}`
        : `Writing ${file || "a file"}`;
    case "apply_patch":
      return done ? "Updated files" : "Updating files";
    case "think":
      return "Thinking";
    default:
      return done ? "Finished step" : "Working";
  }
}

function iconFor(name: string) {
  if (name === "search_workspace" || name === "filter_table") return Search;
  if (name === "list_files") return FolderOpen;
  if (name === "read_file" || name === "write_file" || name === "write_binary_artifact") {
    return FileText;
  }
  if (name === "exec_command" || name === "run_node" || name === "write_stdin") {
    return Terminal;
  }
  return Wrench;
}

function summarizeOutput(name: string, output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  if (name === "search_workspace") {
    const hits = lines.filter((l) => l.startsWith("[") || l.includes("score"));
    if (hits.length) return `${hits.length} match${hits.length === 1 ? "" : "es"}`;
    return lines[0]?.slice(0, 80) || "No matches";
  }
  if (name === "list_files") {
    const entries = lines.filter((l) => !l.startsWith("Finished"));
    return entries.length ? `${entries.length} items` : "Empty";
  }
  if (name === "read_file") {
    return `${Math.min(lines.length, 99)} lines`;
  }
  const first = lines[0] || "";
  return first.length > 72 ? `${first.slice(0, 72)}…` : first;
}

function AgentRow({
  agent,
  onClick,
}: {
  agent: SubAgentInfo;
  onClick: () => void;
}) {
  const color = subagentColor(agent.color);
  const statusLabel =
    agent.status === "running" || agent.status === "pending"
      ? "working"
      : agent.status === "completed"
        ? "done"
        : agent.status === "failed"
          ? "failed"
          : agent.status;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-scout-lift/60"
    >
      <StatusDot status={agent.status} color={color} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-scout-text">
            {agent.description}
          </span>
          <span className="shrink-0 text-[11px] text-scout-muted">{statusLabel}</span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12px] text-scout-muted">
          {agent.summary || agent.last_activity || agent.status}
        </div>
      </div>
    </button>
  );
}

function ToolEventCard({
  name,
  args,
  output,
  running,
}: {
  name: string;
  args?: Record<string, unknown>;
  output?: string;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(name);
  const label = friendlyToolLabel(name, args, !running);
  const summary = output ? summarizeOutput(name, output) : running ? "…" : "";

  // For running tools, never expand raw dump
  const canExpand = Boolean(output) && !running;

  return (
    <div className="rounded-xl border border-scout-hairline-faint bg-scout-panel/70">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${
          canExpand ? "hover:bg-scout-lift/40" : ""
        }`}
      >
        {running ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-scout-muted" />
        ) : (
          <Icon size={12} className="shrink-0 text-scout-muted" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-scout-text">
          {label}
        </span>
        {summary && (
          <span className="max-w-[40%] shrink-0 truncate text-[11px] text-scout-muted">
            {summary}
          </span>
        )}
        {canExpand && (
          <ChevronRight
            size={12}
            className={`shrink-0 text-scout-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && output && (
        <pre className="max-h-36 overflow-auto border-t border-scout-hairline-faint px-2.5 py-2 font-mono text-[11px] leading-relaxed text-scout-muted whitespace-pre-wrap">
          {output.slice(0, 1200)}
          {output.length > 1200 ? "…" : ""}
        </pre>
      )}
    </div>
  );
}

/** Collapse tool_call + tool_result pairs; skip noisy status echoes. */
function buildTimeline(events: SubAgentEvent[]) {
  const items: Array<
    | { kind: "user"; event: SubAgentEvent }
    | { kind: "text"; event: SubAgentEvent }
    | { kind: "thinking"; event: SubAgentEvent }
    | { kind: "tool"; name: string; args?: Record<string, unknown>; output?: string; running: boolean; id: string }
    | { kind: "done"; event: SubAgentEvent }
  > = [];

  const openTools = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const type = ev.type || "";
    if (type === "subagent_user_message" || type === "subagent_message_queued") {
      items.push({ kind: "user", event: ev });
      continue;
    }
    if (type === "subagent_thinking") {
      items.push({ kind: "thinking", event: ev });
      continue;
    }
    if (type === "subagent_text") {
      items.push({ kind: "text", event: ev });
      continue;
    }
    if (type === "subagent_tool_call") {
      const id = String(ev.tool_call_id || `t-${i}`);
      openTools.set(id, items.length);
      items.push({
        kind: "tool",
        name: String(ev.name || "tool"),
        args: ev.args as Record<string, unknown> | undefined,
        running: true,
        id,
      });
      continue;
    }
    if (type === "subagent_tool_result") {
      const id = String(ev.tool_call_id || "");
      const idx = id ? openTools.get(id) : undefined;
      if (idx != null && items[idx]?.kind === "tool") {
        const tool = items[idx] as {
          kind: "tool";
          name: string;
          args?: Record<string, unknown>;
          output?: string;
          running: boolean;
          id: string;
        };
        tool.running = false;
        tool.output = String(ev.output || "");
        openTools.delete(id);
      } else {
        items.push({
          kind: "tool",
          name: String(ev.name || "tool"),
          output: String(ev.output || ""),
          running: false,
          id: `r-${i}`,
        });
      }
      continue;
    }
    if (
      type === "subagent_completed" ||
      type === "subagent_failed" ||
      type === "subagent_stopped"
    ) {
      items.push({ kind: "done", event: ev });
      continue;
    }
    // Skip raw subagent_status / "Finished list_files" noise
  }
  return items;
}

function TimelineItem({
  item,
  baseUrl,
  token,
}: {
  item: ReturnType<typeof buildTimeline>[number];
  baseUrl?: string;
  token?: string | null;
}) {
  if (item.kind === "user") {
    const text = String(item.event.content || item.event.preview || "");
    const who =
      item.event.source === "user"
        ? "You"
        : item.event.source === "parent"
          ? "Scout"
          : "Message";
    return (
      <div className="flex justify-end">
        <div className="max-w-[92%] rounded-2xl rounded-br-md bg-scout-lift/90 px-3 py-2 text-[13px] text-scout-text">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-scout-muted">
            {who}
          </div>
          <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
        </div>
      </div>
    );
  }
  if (item.kind === "thinking") {
    const title = String(item.event.title || "Thinking");
    return (
      <div className="text-[12px] text-scout-muted">
        <span className="font-medium text-scout-text/75">{title}</span>
      </div>
    );
  }
  if (item.kind === "text") {
    return (
      <div className="text-[13px] leading-relaxed text-scout-text/90">
        <MarkdownRenderer
          content={String(item.event.content || "")}
          baseUrl={baseUrl}
          token={token}
        />
      </div>
    );
  }
  if (item.kind === "tool") {
    return (
      <ToolEventCard
        name={item.name}
        args={item.args}
        output={item.output}
        running={item.running}
      />
    );
  }
  if (item.kind === "done") {
    return (
      <div className="pt-1 text-[12px] font-medium text-scout-muted">
        {String(item.event.summary || "Done")}
      </div>
    );
  }
  return null;
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
  baseUrl = "",
  token = null,
}: AgentsPanelProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.events?.length, detail?.result, detail?.status]);

  useEffect(() => {
    setDraft("");
    setError(null);
  }, [selectedId]);

  const inDetail = Boolean(selectedId && detail);
  const color = subagentColor(detail?.color);
  const isLive = detail?.status === "running" || detail?.status === "pending";
  const canMessage = detail && detail.status !== "expired" && detail.can_message !== false;
  const timeline = detail?.events ? buildTimeline(detail.events) : [];
  const timelineHasFinalText = timeline.some(
    (item) => item.kind === "text" && String(item.event.content || "").trim().length > 0,
  );
  const showResultFallback = Boolean(
    detail?.result?.trim() && !timelineHasFinalText,
  );

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

  const placeholder = isLive
    ? "Redirect or add instructions…"
    : detail?.status === "completed" || detail?.status === "failed"
      ? "Send a follow-up while this agent is still available…"
      : "Message this agent…";

  return (
    <div className="flex h-full min-h-0 flex-col bg-scout-canvas">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-scout-hairline-faint px-3">
        {inDetail ? (
          <button
            type="button"
            className={headerIconButtonClass}
            onClick={onBack}
            title="Back to list"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <Bot size={16} className="text-scout-muted" />
        )}
        <div className="min-w-0 flex-1">
          {inDetail ? (
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot status={detail!.status} color={color} />
              <span className="truncate text-[13px] font-semibold text-scout-text">
                {detail!.description}
              </span>
            </div>
          ) : (
            <span className="text-[13px] font-semibold text-scout-text">Agents</span>
          )}
        </div>
        {inDetail && isLive && (
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
        <button type="button" className={headerIconButtonClass} onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </div>

      {!inDetail && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-scout-muted">
            Active
          </div>
          {active.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-scout-muted">Nothing running</div>
          ) : (
            active.map((a) => (
              <AgentRow key={a.agent_id} agent={a} onClick={() => onSelect(a.agent_id)} />
            ))
          )}
          <div className="mt-4 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-scout-muted">
            Done{done.length ? ` · ${done.length}` : ""}
          </div>
          {done.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-scout-muted">No finished agents yet</div>
          ) : (
            done.map((a) => (
              <AgentRow key={a.agent_id} agent={a} onClick={() => onSelect(a.agent_id)} />
            ))
          )}
        </div>
      )}

      {inDetail && detail && (
        <>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {timeline.map((item, i) => (
              <TimelineItem key={i} item={item} baseUrl={baseUrl} token={token} />
            ))}
            {/* Result can land before SSE text events; never leave the pane blank when done. */}
            {showResultFallback && (
              <div className="text-[13px] leading-relaxed text-scout-text/90">
                <MarkdownRenderer content={detail.result || ""} baseUrl={baseUrl} token={token} />
              </div>
            )}
            {!timeline.length && !detail.result && (
              <div className="flex items-center gap-2 text-[12px] text-scout-muted">
                {isLive && <Loader2 size={14} className="animate-spin" />}
                {detail.last_activity || "Starting…"}
              </div>
            )}
            {isLive && timeline.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-scout-muted">
                <Loader2 size={11} className="animate-spin" />
                Live
              </div>
            )}
            <div ref={bottomRef} />
          </div>

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
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder={placeholder}
                  className="min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13px] leading-relaxed text-scout-text outline-none placeholder:text-scout-muted/70"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div className="flex items-center justify-end gap-2 px-2 pb-2">
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
                    {sending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ArrowUp size={16} strokeWidth={2.4} />
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-scout-hairline-faint bg-scout-panel px-3 py-2 text-[12px] text-scout-muted">
                This agent is no longer available.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function SubagentChipRow({
  agents,
  onOpen,
}: {
  agents: SubAgentInfo[];
  onOpen: (id: string) => void;
}) {
  if (!agents.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 py-1">
      {agents.map((a) => {
        const color = subagentColor(a.color);
        const running = a.status === "running" || a.status === "pending";
        return (
          <button
            key={a.agent_id}
            type="button"
            onClick={() => onOpen(a.agent_id)}
            className="inline-flex items-center gap-1.5 rounded-full border border-scout-hairline-faint bg-scout-panel px-2.5 py-1 text-[12px] text-scout-text transition-colors hover:bg-scout-lift/70"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse" : ""}`}
              style={{ backgroundColor: color }}
            />
            <span className="font-medium">{a.description}</span>
            <span className="text-scout-muted">
              {running ? "working" : a.status === "completed" ? "done" : a.status}
            </span>
          </button>
        );
      })}
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
  if (!active.length) return null;
  const label =
    active.length === 1
      ? `${active[0].description} · running`
      : `${active.length} agents running`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-auto mb-1 flex w-full max-w-[46rem] items-center gap-2 px-4 text-left text-[12px] text-scout-muted hover:text-scout-text"
    >
      <Loader2 size={12} className="shrink-0 animate-spin" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-scout-accent">View</span>
    </button>
  );
}
