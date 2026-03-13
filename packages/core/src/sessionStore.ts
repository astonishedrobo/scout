/**
 * Session persistence using JSONL files.
 *
 * Storage layout:
 *   ~/.config/scout/sessions/<project-hash>/<session-uuid>.jsonl
 *
 * Each JSONL file starts with a header line, followed by one line per
 * user/assistant turn.  Append-only writes make this crash-safe.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Message, ToolStep } from "./types.js";

/* ── Types ────────────────────────────────────────────────────────── */

export interface SessionMeta {
  sessionId: string;
  projectDir: string;
  title: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  messageCount: number;
  model?: string;
}

interface HeaderLine {
  type: "header";
  sessionId: string;
  projectDir: string;
  createdAt: string;
  title: string;
  model?: string;
}

interface UserLine {
  type: "user";
  timestamp: string;
  content: string;
  attachments?: string[];
}

interface AssistantLine {
  type: "assistant";
  timestamp: string;
  content: string;
  steps?: ToolStep[];
  model?: string;
}

type JournalLine = HeaderLine | UserLine | AssistantLine;

/* ── Constants ────────────────────────────────────────────────────── */

const SESSIONS_ROOT = join(homedir(), ".config", "scout", "sessions");
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_COUNT = 100;

/* ── Helpers ──────────────────────────────────────────────────────── */

function projectHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
}

export function sessionDir(cwd: string): string {
  return join(SESSIONS_ROOT, projectHash(cwd));
}

function sessionFile(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd), `${sessionId}.jsonl`);
}

function jsonLine(obj: JournalLine): string {
  return JSON.stringify(obj) + "\n";
}

function titleFromContent(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;
  return cleaned.slice(0, 57) + "…";
}

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Create a new session JSONL file.  Returns the session ID.
 */
export function createSession(cwd: string, model?: string): string {
  const id = randomUUID();
  const dir = sessionDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const header: HeaderLine = {
    type: "header",
    sessionId: id,
    projectDir: resolve(cwd),
    createdAt: new Date().toISOString(),
    title: "New session",
    model,
  };
  writeFileSync(sessionFile(cwd, id), jsonLine(header), { mode: 0o600 });
  return id;
}

/**
 * Append a user message to the session journal.
 */
export function appendUserMessage(
  cwd: string,
  sessionId: string,
  content: string,
  attachments?: string[],
): void {
  const line: UserLine = {
    type: "user",
    timestamp: new Date().toISOString(),
    content,
    ...(attachments?.length ? { attachments } : {}),
  };
  appendFileSync(sessionFile(cwd, sessionId), jsonLine(line));
  updateTitle(cwd, sessionId, content);
}

/**
 * Append an assistant response to the session journal.
 */
export function appendAssistantMessage(
  cwd: string,
  sessionId: string,
  content: string,
  steps?: ToolStep[],
  model?: string,
): void {
  const line: AssistantLine = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    content,
    ...(steps?.length ? { steps } : {}),
    ...(model ? { model } : {}),
  };
  appendFileSync(sessionFile(cwd, sessionId), jsonLine(line));
}

/**
 * Load a full session: metadata + all messages.
 */
export function loadSession(
  cwd: string,
  sessionId: string,
): { meta: SessionMeta; messages: Message[] } {
  const file = sessionFile(cwd, sessionId);
  if (!existsSync(file)) {
    throw new Error(`Session file not found: ${sessionId}`);
  }

  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let header: HeaderLine | null = null;
  const messages: Message[] = [];
  let lastTimestamp = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as JournalLine;
      if (parsed.type === "header") {
        header = parsed;
      } else if (parsed.type === "user") {
        messages.push({ role: "user", content: parsed.content });
        lastTimestamp = parsed.timestamp;
      } else if (parsed.type === "assistant") {
        messages.push({
          role: "assistant",
          content: parsed.content,
          steps: parsed.steps,
        });
        lastTimestamp = parsed.timestamp;
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (!header) throw new Error(`Malformed session file: ${sessionId}`);

  const meta: SessionMeta = {
    sessionId: header.sessionId,
    projectDir: header.projectDir,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt: lastTimestamp || header.createdAt,
    messageCount: messages.length,
    model: header.model,
  };

  return { meta, messages };
}

/**
 * List all sessions for the current project directory, sorted by
 * most recently updated first.
 */
export function listSessions(cwd: string): SessionMeta[] {
  const dir = sessionDir(cwd);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) continue;

      const header = JSON.parse(lines[0]) as HeaderLine;
      if (header.type !== "header") continue;

      // Count messages (lines after header)
      const messageCount = lines.length - 1;

      // Get timestamp of last line for updatedAt
      let updatedAt = header.createdAt;
      if (lines.length > 1) {
        try {
          const last = JSON.parse(lines[lines.length - 1]) as UserLine | AssistantLine;
          if (last.timestamp) updatedAt = last.timestamp;
        } catch { /* use createdAt */ }
      }

      sessions.push({
        sessionId: header.sessionId,
        projectDir: header.projectDir,
        title: header.title,
        createdAt: header.createdAt,
        updatedAt,
        messageCount,
        model: header.model,
      });
    } catch {
      // Skip unreadable files
    }
  }

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

/**
 * Delete a session's JSONL file.
 */
export function deleteSession(cwd: string, sessionId: string): void {
  const file = sessionFile(cwd, sessionId);
  if (existsSync(file)) unlinkSync(file);
}

/**
 * Prune sessions exceeding age or count limits.
 */
export function pruneOldSessions(
  cwd: string,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
  maxCount: number = DEFAULT_MAX_COUNT,
): void {
  const sessions = listSessions(cwd);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const age = now - new Date(s.updatedAt).getTime();
    if (i >= maxCount || age > maxAgeMs) {
      deleteSession(cwd, s.sessionId);
    }
  }
}

/* ── Internal ─────────────────────────────────────────────────────── */

/**
 * Update the session title from the first user message.
 * Only updates if title is still the default "New session".
 */
function updateTitle(cwd: string, sessionId: string, firstContent: string): void {
  const file = sessionFile(cwd, sessionId);
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n");

  try {
    const header = JSON.parse(lines[0]) as HeaderLine;
    if (header.title !== "New session") return;

    header.title = titleFromContent(firstContent);
    lines[0] = JSON.stringify(header);
    writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  } catch {
    // Best-effort — don't crash on title update failure
  }
}
