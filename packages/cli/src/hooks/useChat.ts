/**
 * Chat hook: manages conversation state and server communication.
 *
 * Tracks tool steps with status (executing → complete) for the
 * ActivityLog component.  Optionally persists turns to a JSONL session.
 */

import { useState, useCallback } from "react";
import {
  streamChat,
  resetConversation,
  parseFileRefs,
  appendUserMessage,
  appendAssistantMessage,
} from "scout-core";
import type { ChatEvent, ToolStep, Message } from "scout-core";
import type { ApprovalRequest } from "../components/ApprovalPrompt.js";

interface UseChatOptions {
  baseUrl: string;
  cwd: string;
  /** Current session ID (null = no persistence). */
  sessionId: string | null;
  /** Active model name (recorded in assistant lines). */
  model?: string;
}

interface UseChatReturn {
  messages: Message[];
  /** Replace the messages array (used when restoring a session). */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Live tool steps for the current streaming response. */
  streamingSteps: ToolStep[];
  /** Current tool being executed (for ThinkingBar). */
  currentTool: string | undefined;
  /** Current non-tool status from the server. */
  statusMessage: string | undefined;
  isLoading: boolean;
  error: string | null;
  /** Pending write-approval request (null if none). */
  pendingApproval: ApprovalRequest | null;
  /** Clear the pending approval (called after user responds). */
  clearApproval: () => void;
  /** Send a message. Pass explicit `sessionOverride` when the session
   *  was just created in the same tick (avoids stale closure). */
  sendMessage: (text: string, sessionOverride?: string) => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Build enriched ToolStep list from raw ChatEvent stream.
 *
 * When a `tool_call` event arrives, a new step is added with
 * status "executing".  When a `tool_result` arrives, the last
 * executing step with the matching name is marked "complete".
 */
function applyEvent(steps: ToolStep[], event: ChatEvent): ToolStep[] {
  if (event.type === "reflection") {
    const reflection = (event.content ?? "").trim();
    if (!reflection) return steps;
    return [
      ...steps,
      {
        kind: "reflection",
        name: "reflection",
        args: {},
        status: "complete",
        reflection,
      },
    ];
  }

  if (event.type === "tool_call") {
    return [
      ...steps,
      {
        kind: "tool",
        name: event.name ?? "unknown",
        args: event.args ?? {},
        status: "executing",
      },
    ];
  }
  if (event.type === "tool_result") {
    const updated = [...steps];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].status === "executing" && updated[i].name === (event.name || updated[i].name)) {
        updated[i] = {
          ...updated[i],
          status: "complete",
          output: event.output_preview ?? event.output,
        };
        break;
      }
    }
    return updated;
  }
  return steps;
}

export function useChat({ baseUrl, cwd, sessionId, model }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingSteps, setStreamingSteps] = useState<ToolStep[]>([]);
  const [currentTool, setCurrentTool] = useState<string | undefined>();
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);

  const clearApproval = useCallback(() => {
    setPendingApproval(null);
  }, []);

  const sendMessage = useCallback(
    async (text: string, sessionOverride?: string) => {
      const effectiveSession = sessionOverride ?? sessionId;

      setError(null);
      setIsLoading(true);
      setStreamingSteps([]);
      setCurrentTool(undefined);
      setStatusMessage(undefined);

      const { cleanedMessage, attachments } = parseFileRefs(text);
      const displayMessage = text;
      const serverMessage = cleanedMessage || text;

      setMessages((prev) => [
        ...prev,
        { role: "user", content: displayMessage },
      ]);

      // Persist user message
      if (effectiveSession) {
        try {
          appendUserMessage(
            cwd,
            effectiveSession,
            displayMessage,
            attachments.length ? attachments.map((a) => a.path) : undefined,
          );
        } catch { /* best-effort */ }
      }

      let steps: ToolStep[] = [];
      let finalContent = "";

      const dbg = !!process.env.SCOUT_DEBUG;

      try {
        let gotAnyEvent = false;
        for await (const event of streamChat({
          baseUrl,
          message: serverMessage,
          attachments: attachments.map((a) => a.path),
        })) {
          gotAnyEvent = true;

          if (dbg) {
            process.stderr.write(
              `[useChat] event: type=${event.type} name=${event.name ?? "-"}\n`,
            );
          }

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

          if (event.type === "status") {
            setStatusMessage(event.message);
            continue;
          }

          if (event.type === "response") {
            finalContent = event.content ?? "";
            setStatusMessage(undefined);
          } else if (event.type === "tool_call" || event.type === "tool_result" || event.type === "reflection") {
            steps = applyEvent(steps, event);
            setStreamingSteps([...steps]);
            setStatusMessage(undefined);

            if (event.type === "tool_call") {
              setCurrentTool(event.name);
            } else if (event.type === "tool_result") {
              const stillRunning = steps.find((s) => s.status === "executing");
              setCurrentTool(stillRunning?.name);
            } else if (event.type === "reflection") {
              setCurrentTool(undefined);
            }
          }
        }

        if (dbg) {
          process.stderr.write(
            `[useChat] stream done: ${steps.length} steps, content=${finalContent.length} chars\n`,
          );
        }

        if (finalContent || steps.length > 0) {
          const assistantMsg: Message = {
            role: "assistant",
            content: finalContent || "(no text response)",
            steps: [...steps],
          };
          setMessages((prev) => [...prev, assistantMsg]);

          // Persist assistant message
          if (effectiveSession) {
            try {
              appendAssistantMessage(
                cwd,
                effectiveSession,
                assistantMsg.content,
                assistantMsg.steps,
                model,
              );
            } catch { /* best-effort */ }
          }
        } else if (gotAnyEvent) {
          setError("Server returned events but no final response.");
        } else {
          setError(
            "No response from server. Check server logs " +
              "(run with SCOUT_DEBUG=1 for details)."
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg || "Unknown error communicating with server");
      } finally {
        setIsLoading(false);
        setStreamingSteps([]);
        setCurrentTool(undefined);
        setStatusMessage(undefined);
      }
    },
    [baseUrl, cwd, sessionId, model]
  );

  const reset = useCallback(async () => {
    await resetConversation(baseUrl);
    setMessages([]);
    setStreamingSteps([]);
    setCurrentTool(undefined);
    setError(null);
  }, [baseUrl]);

  return {
    messages,
    setMessages,
    streamingSteps,
    currentTool,
    statusMessage,
    isLoading,
    error,
    pendingApproval,
    clearApproval,
    sendMessage,
    reset,
  };
}
