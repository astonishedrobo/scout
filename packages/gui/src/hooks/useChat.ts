import { useState, useCallback, useRef } from "react";
import type {
  ChatEvent, ToolStep, Message, FileDiffEntry, Artifact,
  CapabilityRequestPayload, ChatImage, UserInputRequest, FileChangeSet, ResponseAnnotation,
} from "scout-core";

export interface PermissionElevationPayload {
  reason: string;
  network_domains?: string[];
}

export interface ApprovalRequest {
  approvalId: string;
  kind: "file_changes" | "capability" | "execution_promotion" | "permission_elevation";
  toolName: string;
  diffs: FileDiffEntry[];
  capability?: CapabilityRequestPayload;
  permissionRequest?: PermissionElevationPayload;
  canShare: boolean;
  subagentId?: string;
  subagentDescription?: string;
}

interface ChatState {
  messages: Message[];
  streamingSteps: ToolStep[];
  streamingText: string;
  currentTool?: string;
  statusMessage?: string;
  isLoading: boolean;
  error: string | null;
  pendingApproval: ApprovalRequest | null;
  pendingUserInput: UserInputRequest | null;
}

const emptyState = (): ChatState => ({
  messages: [], streamingSteps: [], streamingText: "", currentTool: undefined, statusMessage: undefined,
  isLoading: false, error: null, pendingApproval: null, pendingUserInput: null,
});

/** Normalize sandbox / relative paths so the same file maps to one card. */
function artifactPathKey(path: string | undefined | null): string {
  let raw = (path || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  while (raw.startsWith("./")) raw = raw.slice(2);
  if (raw.startsWith("/workspace/")) raw = raw.slice("/workspace/".length);
  else if (raw.startsWith("workspace/shared/")) raw = `shared/${raw.slice("workspace/shared/".length)}`;
  else if (raw.startsWith("workspace/")) raw = raw.slice("workspace/".length);
  if (raw.startsWith("/shared/")) raw = `shared/${raw.slice("/shared/".length)}`;
  else if (raw === "/shared") raw = "shared";
  return raw.replace(/^\/+/, "");
}

function sameArtifact(a: Artifact, b: Artifact): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const ka = artifactPathKey(a.path);
  const kb = artifactPathKey(b.path);
  return Boolean(ka && kb && ka === kb);
}

interface UseChatOptions {
  baseUrl: string;
  sessionId: string;
  token: string | null;
  onUserMessage?: () => Promise<string | void> | string | void;
  onUserAccepted?: (sessionId: string, text: string, attachments: string[], chatImages: ChatImage[], annotations: ResponseAnnotation[]) => Promise<void> | void;
  onAssistantMessage?: (
    sessionId: string,
    content: string,
    steps: ToolStep[],
    artifacts: Artifact[],
    fileChanges: FileChangeSet[],
    extra?: { stopped?: boolean },
  ) => Promise<void> | void;
  onSessionTitle?: (sessionId: string, title: string) => void;
}

/** Mark in-flight tools as interrupted so the timeline stays after Stop. */
function sealSteps(steps: ToolStep[]): ToolStep[] {
  return steps.map((step) =>
    step.status === "executing"
      ? {
          ...step,
          status: "interrupted" as const,
          output: step.output?.trim()
            ? `${step.output}\n\n[Interrupted]`
            : "[Interrupted — tool did not finish]",
        }
      : step,
  );
}

function applyEvent(steps: ToolStep[], event: ChatEvent): ToolStep[] {
  if (event.type === "thinking") {
    const content = (event.content ?? "").trim();
    if (!content) return steps;
    return [
      ...steps,
      {
        kind: "thinking",
        name: "think",
        args: {},
        status: "complete",
        title: (event.title ?? "").trim(),
        reflection: content,
        content,
      },
    ];
  }

  // Legacy reflection events → thinking blocks (older servers / sessions).
  if (event.type === "reflection") {
    const reflection = (event.content ?? "").trim();
    if (!reflection) return steps;
    return [
      ...steps,
      {
        kind: "thinking",
        name: "think",
        args: {},
        status: "complete",
        reflection,
        content: reflection,
      },
    ];
  }

  if (event.type === "assistant_text") {
    const content = (event.content ?? "").trim();
    if (!content) return steps;
    return [
      ...steps,
      {
        kind: "text",
        name: "text",
        args: {},
        status: "complete",
        content,
      },
    ];
  }

  if (event.type === "tool_call") {
    return [...steps, { kind: "tool", name: event.name ?? "unknown", args: event.args ?? {}, status: "executing" }];
  }
  if (event.type === "tool_output_chunk" && event.chunk) {
    const updated = [...steps];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].status === "executing") {
        updated[i] = { ...updated[i], output: (updated[i].output ?? "") + event.chunk };
        break;
      }
    }
    return updated;
  }
  if (event.type === "tool_result") {
    const updated = [...steps];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].status === "executing" && updated[i].name === (event.name || updated[i].name)) {
        updated[i] = { ...updated[i], status: "complete", output: event.output || updated[i].output };
        break;
      }
    }
    return updated;
  }
  return steps;
}

export function useChat({
  baseUrl, sessionId, token, onUserMessage, onUserAccepted, onAssistantMessage, onSessionTitle,
}: UseChatOptions) {
  const [states, setStates] = useState<Record<string, ChatState>>({});
  const statesRef = useRef(states);
  statesRef.current = states;
  const abortRefs = useRef(new Map<string, AbortController>());
  const active = states[sessionId] ?? emptyState();

  const update = useCallback((id: string, fn: (state: ChatState) => ChatState) => {
    setStates((prev) => {
      const next = { ...prev, [id]: fn(prev[id] ?? emptyState()) };
      statesRef.current = next;
      return next;
    });
  }, []);

  const setMessagesForSession = useCallback((id: string, messages: Message[], force = false) => {
    update(id, (state) => state.isLoading && !force ? state : { ...state, messages });
  }, [update]);

  const setMessages = useCallback((value: React.SetStateAction<Message[]>) => {
    update(sessionId, (state) => ({
      ...state,
      messages: typeof value === "function" ? value(state.messages) : value,
    }));
  }, [sessionId, update]);

  const clearApproval = useCallback(() => {
    update(sessionId, (state) => ({ ...state, pendingApproval: null }));
  }, [sessionId, update]);

  const receiveApproval = useCallback((
    event: Record<string, unknown>,
    targetSessionId = sessionId,
  ) => {
    update(targetSessionId, (state) => ({
      ...state,
      pendingApproval: {
        approvalId: String(event.approval_id ?? ""),
        kind: (event.kind as ApprovalRequest["kind"]) ?? "file_changes",
        toolName: String(event.tool_name ?? ""),
        diffs: (event.diffs as FileDiffEntry[]) ?? [],
        capability: event.capability as CapabilityRequestPayload | undefined,
        permissionRequest: event.permission_request as PermissionElevationPayload | undefined,
        canShare: Boolean(event.can_share),
        subagentId: event.subagent_id ? String(event.subagent_id) : undefined,
        subagentDescription: event.subagent_description
          ? String(event.subagent_description)
          : undefined,
      },
    }));
  }, [sessionId, update]);

  const clearUserInput = useCallback(() => {
    update(sessionId, (state) => ({ ...state, pendingUserInput: null }));
  }, [sessionId, update]);

  const isSessionLoading = useCallback((id: string) => {
    return !!statesRef.current[id]?.isLoading;
  }, []);

  const clearSession = useCallback((id: string) => {
    abortRefs.current.get(id)?.abort();
    setStates((prev) => {
      const next = { ...prev };
      delete next[id];
      statesRef.current = next;
      return next;
    });
  }, []);

  const sendMessage = useCallback(async (
    text: string, attachments: string[] = [], chatImages: ChatImage[] = [], onAccepted?: () => void, annotations: ResponseAnnotation[] = [],
  ) => {
    let requestSessionId = sessionId;
    try {
      const resolved = await onUserMessage?.();
      if (resolved) requestSessionId = resolved;
    } catch { /* surfaced by request if session is unavailable */ }

    if (statesRef.current[requestSessionId]?.isLoading) return false;
    // Show the user message immediately (optimistic) — waiting for the server's
    // `accepted` event leaves a visible gap where the message exists nowhere.
    const optimisticUser: Message = { role: "user", content: text, attachments, chatImages, annotations };
    update(requestSessionId, (state) => ({
      ...state, error: null, isLoading: true, streamingSteps: [], streamingText: "", currentTool: undefined, statusMessage: "Waiting for server capacity…", pendingUserInput: null,
      messages: [...state.messages, optimisticUser],
    }));

    const controller = new AbortController();
    abortRefs.current.set(requestSessionId, controller);
    let steps: ToolStep[] = [];
    let finalContent = "";
    let accepted = false;
    let userInputRequested = false;
    let interrupted = false;
    let committed = false;
    const artifacts: Artifact[] = [];
    const fileChanges: FileChangeSet[] = [];

    const commitAssistant = async (opts: { stopped?: boolean } = {}) => {
      if (committed || userInputRequested) return;
      const sealed = opts.stopped ? sealSteps(steps) : [...steps];
      steps = sealed;
      if (!finalContent && !sealed.length && !artifacts.length && !fileChanges.length) return;
      committed = true;
      const content = finalContent || (opts.stopped ? "" : "(no text response)");
      // Clear the streaming copy in the SAME update that commits the final
      // message — separate updates flash both copies on screen at once.
      update(requestSessionId, (state) => ({
        ...state,
        messages: [...state.messages, {
          role: "assistant",
          content,
          steps: sealed,
          artifacts: [...artifacts],
          fileChanges: [...fileChanges],
          ...(opts.stopped ? { stopped: true } : {}),
        }],
        isLoading: false,
        streamingSteps: [],
        streamingText: "",
        currentTool: undefined,
        statusMessage: undefined,
        pendingApproval: opts.stopped ? null : state.pendingApproval,
      }));
      try {
        await onAssistantMessage?.(
          requestSessionId,
          content,
          sealed,
          [...artifacts],
          [...fileChanges],
          opts.stopped ? { stopped: true } : undefined,
        );
      } catch { /* best effort */ }
    };

    try {
      const resp = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          message: text, session_id: requestSessionId, attachments,
          chat_image_ids: chatImages.map((image) => image.id),
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(body?.detail?.message ?? body?.detail ?? `Server returned ${resp.status}`);
      }
      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as ChatEvent;
            if (event.session_id && event.session_id !== requestSessionId) continue;
            if (event.type === "accepted") {
              if (!accepted) {
                accepted = true;
                update(requestSessionId, (state) => ({
                  ...state, statusMessage: "Starting agent…",
                }));
                try { onAccepted?.(); } catch { /* best effort */ }
                try { await onUserAccepted?.(requestSessionId, text, attachments, chatImages, annotations); } catch { /* best effort */ }
              }
              continue;
            }
            if (event.type === "interrupted") {
              interrupted = true;
              if (event.content) finalContent = event.content;
              update(requestSessionId, (state) => ({
                ...state,
                pendingApproval: null,
                streamingText: finalContent || state.streamingText,
                statusMessage: undefined,
              }));
              streamDone = true;
              break;
            }
            if (event.type === "error") {
              // Back-compat: older servers signaled stop as an error.
              if ((event.message ?? "").toLowerCase().includes("interrupted by user")) {
                interrupted = true;
                streamDone = true;
                break;
              }
              update(requestSessionId, (state) => ({ ...state, error: event.message ?? "Unknown server error" }));
              streamDone = true;
              break;
            }
            if (event.type === "approval_request") {
              receiveApproval(event as unknown as Record<string, unknown>, requestSessionId);
              continue;
            }
            if (event.type === "user_input_request") {
              userInputRequested = true;
              const pausedSteps = [...steps];
              update(requestSessionId, (state) => ({
                ...state,
                messages: pausedSteps.length > 0
                  ? [...state.messages, { role: "assistant", content: "", steps: pausedSteps }]
                  : state.messages,
                pendingUserInput: {
                  request_id: event.request_id ?? "",
                  questions: event.questions ?? [],
                },
                streamingSteps: [],
                streamingText: "",
                statusMessage: undefined,
                isLoading: false,
              }));
              if (pausedSteps.length > 0) {
                try { await onAssistantMessage?.(requestSessionId, "", pausedSteps, [], []); } catch { /* best effort */ }
              }
              streamDone = true;
              break;
            }
            if (event.type === "session_title" && event.title) {
              onSessionTitle?.(requestSessionId, event.title);
              continue;
            }
            if (event.type === "status") {
              update(requestSessionId, (state) => ({ ...state, statusMessage: event.message }));
              continue;
            }
            if (event.type === "response") {
              finalContent = event.content ?? "";
              update(requestSessionId, (state) => ({ ...state, streamingText: finalContent, statusMessage: undefined }));
              continue;
            }
            if (event.artifacts?.length) {
              for (const artifact of event.artifacts) {
                if (!artifacts.some((existing) => sameArtifact(existing, artifact))) {
                  artifacts.push(artifact);
                }
              }
            }
            if (event.file_changes?.length) {
              for (const changeSet of event.file_changes) {
                if (!fileChanges.some((existing) => existing.id === changeSet.id)) fileChanges.push(changeSet);
              }
            }
            if (
              event.type === "tool_call"
              || event.type === "tool_output_chunk"
              || event.type === "tool_result"
              || event.type === "thinking"
              || event.type === "assistant_text"
              || event.type === "reflection"
            ) {
              steps = applyEvent(steps, event);
              update(requestSessionId, (state) => ({
                ...state, streamingSteps: [...steps],
                statusMessage: undefined,
                currentTool: event.type === "tool_call" ? event.name : steps.find((step) => step.status === "executing")?.name,
              }));
            }
          } catch { /* skip malformed event */ }
        }
      }
      if (interrupted) {
        await commitAssistant({ stopped: true });
      } else if (!userInputRequested && (finalContent || steps.length > 0)) {
        await commitAssistant();
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (aborted) {
        interrupted = true;
        // Client aborted after /chat/stop (or user navigated away) — keep partial turn.
        const live = statesRef.current[requestSessionId];
        if (!finalContent && live?.streamingText) finalContent = live.streamingText;
        if (!steps.length && live?.streamingSteps?.length) steps = [...live.streamingSteps];
        await commitAssistant({ stopped: true });
      } else {
        update(requestSessionId, (state) => ({
          ...state,
          error: err instanceof Error ? err.message : String(err),
          // Server never accepted the message — drop the optimistic copy so the
          // input bar can restore the draft without duplicating it in the chat.
          messages: accepted ? state.messages : state.messages.filter((message) => message !== optimisticUser),
        }));
      }
    } finally {
      abortRefs.current.delete(requestSessionId);
      update(requestSessionId, (state) => ({
        ...state,
        isLoading: false,
        streamingSteps: [],
        streamingText: "",
        currentTool: undefined,
        statusMessage: undefined,
        pendingApproval: interrupted ? null : state.pendingApproval,
      }));
    }
    return accepted;
  }, [baseUrl, sessionId, token, onUserMessage, onUserAccepted, onAssistantMessage, onSessionTitle, receiveApproval, update]);

  const stop = useCallback(async () => {
    // Clear approval UI immediately; server declines pending approval on /chat/stop.
    update(sessionId, (state) => ({ ...state, pendingApproval: null }));
    // Signal server first so it can seal agent history and emit `interrupted`.
    await fetch(`${baseUrl}/chat/stop?session_id=${sessionId}`, {
      method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
    // Fallback: if the SSE stream does not end promptly, abort the client reader.
    // Partial turn is still committed in the AbortError path.
    window.setTimeout(() => {
      abortRefs.current.get(sessionId)?.abort();
    }, 1500);
  }, [baseUrl, sessionId, token, update]);

  const reset = useCallback(async () => {
    abortRefs.current.get(sessionId)?.abort();
    await fetch(`${baseUrl}/reset?session_id=${sessionId}`, {
      method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
    setMessagesForSession(sessionId, [], true);
    update(sessionId, () => emptyState());
  }, [baseUrl, sessionId, token, setMessagesForSession, update]);

  const retryAt = useCallback(async (assistantIndex: number) => {
    const messages = statesRef.current[sessionId]?.messages ?? [];
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex--;
    if (userIndex < 0) return;
    const user = messages[userIndex];
    const remaining = messages.filter((_, index) => index !== assistantIndex && index !== userIndex);
    setMessagesForSession(sessionId, remaining, true);
    await fetch(`${baseUrl}/reset?session_id=${sessionId}`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined }).catch(() => {});
    if (remaining.length) {
      await fetch(`${baseUrl}/restore?session_id=${sessionId}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ messages: remaining }),
      }).catch(() => {});
    }
    await sendMessage(user.content, user.attachments, user.chatImages, undefined, user.annotations);
  }, [baseUrl, sessionId, token, sendMessage, setMessagesForSession]);

  return {
    messages: active.messages, setMessages, setMessagesForSession,
    streamingSteps: active.streamingSteps, currentTool: active.currentTool,
    streamingText: active.streamingText, statusMessage: active.statusMessage, isLoading: active.isLoading,
    error: active.error, pendingApproval: active.pendingApproval, pendingUserInput: active.pendingUserInput,
    clearApproval, receiveApproval, clearUserInput, isSessionLoading, clearSession, sendMessage, stop, retryAt, reset,
  };
}
