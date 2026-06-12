import { useState, useCallback, useRef } from "react";
import type {
  ChatEvent, ToolStep, Message, FileDiffEntry, Artifact,
  CapabilityRequestPayload, ChatImage,
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
}

interface ChatState {
  messages: Message[];
  streamingSteps: ToolStep[];
  streamingText: string;
  currentTool?: string;
  isLoading: boolean;
  error: string | null;
  pendingApproval: ApprovalRequest | null;
}

const emptyState = (): ChatState => ({
  messages: [], streamingSteps: [], streamingText: "", currentTool: undefined,
  isLoading: false, error: null, pendingApproval: null,
});

interface UseChatOptions {
  baseUrl: string;
  sessionId: string;
  token: string | null;
  onUserMessage?: () => Promise<string | void> | string | void;
  onUserAccepted?: (sessionId: string, text: string, attachments: string[], chatImages: ChatImage[]) => Promise<void> | void;
  onAssistantMessage?: (sessionId: string, content: string, steps: ToolStep[], artifacts: Artifact[]) => Promise<void> | void;
  onSessionTitle?: (sessionId: string, title: string) => void;
}

function applyEvent(steps: ToolStep[], event: ChatEvent): ToolStep[] {
  if (event.type === "tool_call") {
    return [...steps, { name: event.name ?? "unknown", args: event.args ?? {}, status: "executing" }];
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
    text: string, attachments: string[] = [], chatImages: ChatImage[] = [], onAccepted?: () => void,
  ) => {
    let requestSessionId = sessionId;
    try {
      const resolved = await onUserMessage?.();
      if (resolved) requestSessionId = resolved;
    } catch { /* surfaced by request if session is unavailable */ }

    if (statesRef.current[requestSessionId]?.isLoading) return false;
    update(requestSessionId, (state) => ({
      ...state, error: null, isLoading: true, streamingSteps: [], streamingText: "", currentTool: undefined,
    }));

    const controller = new AbortController();
    abortRefs.current.set(requestSessionId, controller);
    let steps: ToolStep[] = [];
    let finalContent = "";
    let accepted = false;
    const artifacts: Artifact[] = [];

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
                  ...state, messages: [...state.messages, { role: "user", content: text, attachments, chatImages }],
                }));
                try { onAccepted?.(); } catch { /* best effort */ }
                try { await onUserAccepted?.(requestSessionId, text, attachments, chatImages); } catch { /* best effort */ }
              }
              continue;
            }
            if (event.type === "error") {
              update(requestSessionId, (state) => ({ ...state, error: event.message ?? "Unknown server error" }));
              streamDone = true;
              break;
            }
            if (event.type === "approval_request") {
              update(requestSessionId, (state) => ({ ...state, pendingApproval: {
                approvalId: event.approval_id ?? "", kind: event.kind ?? "file_changes",
                toolName: event.tool_name ?? "", diffs: event.diffs ?? [], capability: event.capability,
                permissionRequest: event.permission_request, canShare: !!event.can_share,
              } }));
              continue;
            }
            if (event.type === "session_title" && event.title) {
              onSessionTitle?.(requestSessionId, event.title);
              continue;
            }
            if (event.type === "response") {
              finalContent = event.content ?? "";
              update(requestSessionId, (state) => ({ ...state, streamingText: finalContent }));
              continue;
            }
            if (event.artifacts?.length) {
              for (const artifact of event.artifacts) {
                if (!artifacts.some((existing) => existing.id === artifact.id)) artifacts.push(artifact);
              }
            }
            steps = applyEvent(steps, event);
            update(requestSessionId, (state) => ({
              ...state, streamingSteps: [...steps],
              currentTool: event.type === "tool_call" ? event.name : steps.find((step) => step.status === "executing")?.name,
            }));
          } catch { /* skip malformed event */ }
        }
      }
      if (finalContent || steps.length > 0) {
        const content = finalContent || "(no text response)";
        update(requestSessionId, (state) => ({
          ...state, messages: [...state.messages, { role: "assistant", content, steps: [...steps], artifacts: [...artifacts] }],
        }));
        try { await onAssistantMessage?.(requestSessionId, content, [...steps], [...artifacts]); } catch { /* best effort */ }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        update(requestSessionId, (state) => ({ ...state, error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      abortRefs.current.delete(requestSessionId);
      update(requestSessionId, (state) => ({
        ...state, isLoading: false, streamingSteps: [], streamingText: "", currentTool: undefined,
      }));
    }
    return accepted;
  }, [baseUrl, sessionId, token, onUserMessage, onUserAccepted, onAssistantMessage, onSessionTitle, update]);

  const stop = useCallback(async () => {
    abortRefs.current.get(sessionId)?.abort();
    await fetch(`${baseUrl}/chat/stop?session_id=${sessionId}`, {
      method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
  }, [baseUrl, sessionId, token]);

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
    await sendMessage(user.content, user.attachments, user.chatImages);
  }, [baseUrl, sessionId, token, sendMessage, setMessagesForSession]);

  return {
    messages: active.messages, setMessages, setMessagesForSession,
    streamingSteps: active.streamingSteps, currentTool: active.currentTool,
    streamingText: active.streamingText, isLoading: active.isLoading,
    error: active.error, pendingApproval: active.pendingApproval,
    clearApproval, isSessionLoading, clearSession, sendMessage, stop, retryAt, reset,
  };
}
