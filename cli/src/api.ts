/**
 * SSE client for the Scout server's /chat endpoint.
 *
 * Uses the spec-compliant `eventsource-parser` (already a dependency)
 * instead of a hand-rolled SSE parser, so all line-ending formats
 * (CR, LF, CRLF) and multi-line data fields are handled correctly.
 */

import { EventSourceParserStream } from "eventsource-parser/stream";
import type { ChatEvent, ChatImage } from "./types.js";

export interface ChatOptions {
  baseUrl: string;
  sessionId: string;
  message: string;
  attachments?: string[];
  chatImageIds?: string[];
}

/**
 * Stream chat events from the server.
 */
export async function* streamChat(
  opts: ChatOptions
): AsyncGenerator<ChatEvent> {
  const resp = await fetch(`${opts.baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: opts.message,
      session_id: opts.sessionId,
      attachments: opts.attachments ?? [],
      chat_image_ids: opts.chatImageIds ?? [],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`Server returned ${resp.status}: ${body}`);
  }

  if (!resp.body) throw new Error("No response body from server");

  const eventStream = resp.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  const reader = eventStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // value is a parsed SSE event: { event?: string, data: string, id?: string }
      const data = value.data;
      if (!data) continue;

      try {
        const event = JSON.parse(data) as ChatEvent;
        if (process.env.SCOUT_DEBUG) {
          process.stderr.write(
            `[sse] event: ${event.type} ${event.name ?? ""}\n`,
          );
        }
        yield event;
      } catch {
        if (process.env.SCOUT_DEBUG) {
          process.stderr.write(
            `[sse] Failed to parse event data: ${data.slice(0, 200)}\n`,
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Send a reset request to clear conversation. */
export async function resetConversation(baseUrl: string, sessionId: string): Promise<void> {
  await fetch(`${baseUrl}/reset?session_id=${encodeURIComponent(sessionId)}`, { method: "POST" });
}

export async function ensureServerSession(baseUrl: string, sessionId: string, model?: string): Promise<void> {
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  const resp = await fetch(`${baseUrl}/sessions/${sessionId}${query}`, { method: "PUT" });
  if (!resp.ok) throw new Error(`Session registration failed: ${resp.status}`);
}

export async function uploadChatImage(baseUrl: string, sessionId: string, bytes: Uint8Array, name: string, type: string): Promise<ChatImage> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type }), name);
  const resp = await fetch(`${baseUrl}/sessions/${sessionId}/chat-images`, { method: "POST", body: form });
  if (!resp.ok) throw new Error(`Image upload failed: ${resp.status}`);
  return resp.json() as Promise<ChatImage>;
}

/** Get the current config from the server. */
export async function getServerConfig(
  baseUrl: string
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${baseUrl}/config`);
  return resp.json() as Promise<Record<string, unknown>>;
}

/** Set a config value on the server. */
export async function setServerConfig(
  baseUrl: string,
  key: string,
  value: unknown,
  scope: "global" | "project" = "project"
): Promise<void> {
  await fetch(`${baseUrl}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, scope }),
  });
}

/** Send an approval response to the server. */
export async function sendApproval(
  baseUrl: string,
  approvalId: string,
  action: "yes" | "no" | "suggest" | "edit" | "always",
  feedback: string = ""
): Promise<void> {
  await fetch(`${baseUrl}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approval_id: approvalId,
      action,
      feedback,
    }),
  });
}

/** Fetch the configured models list from the server. */
export async function getServerModels(
  baseUrl: string,
): Promise<string[]> {
  try {
    const resp = await fetch(`${baseUrl}/config/models`);
    const body = (await resp.json()) as { models?: string[] };
    return body.models ?? [];
  } catch {
    return [];
  }
}

/** Tell the server to re-read config from disk and re-inject env vars. */
export async function reloadServerConfig(
  baseUrl: string,
): Promise<string[]> {
  try {
    const resp = await fetch(`${baseUrl}/config/reload`, { method: "POST" });
    const body = (await resp.json()) as { models?: string[] };
    return body.models ?? [];
  } catch {
    return [];
  }
}

/** Restore conversation history on the Python server from a persisted session. */
export async function restoreServerSession(
  baseUrl: string,
  sessionId: string,
  messages: { role: "user" | "assistant"; content: string; chatImages?: ChatImage[] }[],
): Promise<number> {
  const resp = await fetch(`${baseUrl}/restore?session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!resp.ok) {
    throw new Error(`Restore failed: ${resp.status}`);
  }
  const body = (await resp.json()) as { count?: number };
  return body.count ?? 0;
}

/** Signal the server that the external editor has closed. */
export async function sendEditDone(
  baseUrl: string,
  approvalId: string,
): Promise<void> {
  await fetch(`${baseUrl}/edit-done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approval_id: approvalId }),
  });
}
