import { useState, useCallback, useRef } from "react";
import type {
  ChatEvent,
  ToolStep,
  Message,
  FileDiffEntry,
} from "scout-core";

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  diffs: FileDiffEntry[];
}

interface UseChatOptions {
  baseUrl: string;
  sessionId: string;
  token: string | null;
  onUserMessage?: (text: string) => Promise<void> | void;
  onAssistantMessage?: (content: string, steps: ToolStep[]) => Promise<void> | void;
}

interface UseChatReturn {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  streamingSteps: ToolStep[];
  currentTool: string | undefined;
  streamingText: string;
  isLoading: boolean;
  error: string | null;
  pendingApproval: ApprovalRequest | null;
  clearApproval: () => void;
  sendMessage: (text: string, attachments?: string[]) => Promise<void>;
  retryAt: (assistantIndex: number) => Promise<void>;
  reset: () => Promise<void>;
}

function applyEvent(steps: ToolStep[], event: ChatEvent): ToolStep[] {
  if (event.type === "tool_call") {
    return [
      ...steps,
      {
        name: event.name ?? "unknown",
        args: event.args ?? {},
        status: "executing",
      },
    ];
  }
  if (event.type === "tool_result") {
    const updated = [...steps];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (
        updated[i].status === "executing" &&
        updated[i].name === (event.name || updated[i].name)
      ) {
        updated[i] = { ...updated[i], status: "complete", output: event.output };
        break;
      }
    }
    return updated;
  }
  return steps;
}

export function useChat({ baseUrl, sessionId, token, onUserMessage, onAssistantMessage }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingSteps, setStreamingSteps] = useState<ToolStep[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [currentTool, setCurrentTool] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearApproval = useCallback(() => setPendingApproval(null), []);

  const sendMessage = useCallback(
    async (text: string, attachments: string[] = []) => {
      setError(null);
      setIsLoading(true);
      setStreamingSteps([]);
      setStreamingText("");
      setCurrentTool(undefined);

      setMessages((prev) => [...prev, { role: "user", content: text }]);

      // Persist user message
      if (onUserMessage) {
        try { await onUserMessage(text); } catch { /* best effort */ }
      }

      const controller = new AbortController();
      abortRef.current = controller;

      let steps: ToolStep[] = [];
      let finalContent = "";

      try {
        const resp = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ message: text, session_id: sessionId, attachments }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "(no body)");
          throw new Error(`Server returned ${resp.status}: ${body}`);
        }

        if (!resp.body) throw new Error("No response body");

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (!data) continue;

            try {
              const event = JSON.parse(data) as ChatEvent;

              if (event.type === "error") {
                setError(event.message ?? "Unknown server error");
                break;
              }

              if (event.type === "approval_request") {
                setPendingApproval({
                  approvalId: event.approval_id ?? "",
                  toolName: event.tool_name ?? "",
                  diffs: event.diffs ?? [],
                });
                continue;
              }

              if (event.type === "response") {
                finalContent = event.content ?? "";
                setStreamingText(finalContent);
              } else {
                steps = applyEvent(steps, event);
                setStreamingSteps([...steps]);
                if (event.type === "tool_call") {
                  setCurrentTool(event.name);
                } else if (event.type === "tool_result") {
                  const still = steps.find((s) => s.status === "executing");
                  setCurrentTool(still?.name);
                }
              }
            } catch {
              // skip malformed
            }
          }
        }

        if (finalContent || steps.length > 0) {
          const content = finalContent || "(no text response)";
          const finalSteps = [...steps];
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content, steps: finalSteps },
          ]);

          // Persist assistant message
          if (onAssistantMessage) {
            try { await onAssistantMessage(content, finalSteps); } catch { /* best effort */ }
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg || "Unknown error");
        }
      } finally {
        setIsLoading(false);
        setStreamingSteps([]);
        setStreamingText("");
        setCurrentTool(undefined);
        abortRef.current = null;
      }
    },
    [baseUrl, sessionId, token, onUserMessage, onAssistantMessage],
  );

  const retryAt = useCallback(
    async (assistantIndex: number) => {
      // Find the user message just before this assistant message
      let userText = "";
      for (let i = assistantIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "user") {
          userText = m.content;
          break;
        }
      }
      if (!userText) return;

      // Remove the assistant message (and keep everything before it)
      setMessages((prev) => prev.filter((_, i) => i !== assistantIndex));

      // Reset backend conversation to match, then re-send
      await fetch(`${baseUrl}/reset?session_id=${sessionId}`, { 
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }).catch(() => {});

      // Restore messages up to the retry point
      const remaining = messages.filter((_, i) => i !== assistantIndex);
      if (remaining.length > 0) {
        await fetch(`${baseUrl}/restore`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ messages: remaining }),
        }).catch(() => {});
      }

      // Re-send (sendMessage will add the user message back, so remove it first)
      setMessages((prev) => prev.filter((m) => !(m.role === "user" && m.content === userText && prev.indexOf(m) === assistantIndex - 1)));

      await sendMessage(userText);
    },
    [messages, baseUrl, sessionId, token, sendMessage],
  );

  const reset = useCallback(async () => {
    abortRef.current?.abort();
    await fetch(`${baseUrl}/reset?session_id=${sessionId}`, { 
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
    setMessages([]);
    setStreamingSteps([]);
    setStreamingText("");
    setCurrentTool(undefined);
    setError(null);
  }, [baseUrl, sessionId, token]);

  return {
    messages,
    setMessages,
    streamingSteps,
    currentTool,
    streamingText,
    isLoading,
    error,
    pendingApproval,
    clearApproval,
    sendMessage,
    retryAt,
    reset,
  };
}
