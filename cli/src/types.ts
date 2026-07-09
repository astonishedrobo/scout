/** Types shared across the Scout CLI. */

export interface LLMProviderConfig {
  api_key: string;
  api_base?: string;
  models: string[];
}

export interface ScoutConfig {
  llm?: {
    providers?: Record<string, LLMProviderConfig>;
  };
  agent?: {
    model?: string;
    temperature?: number;
    max_iterations?: number;
    context_compress_threshold?: number;
    compress_keep_recent?: number;
    conda_env?: string;
    python_path?: string | null;
    code_timeout?: number;
    bad_request_retries?: number;
  };
  retriever?: {
    top_k?: number;
    chunk_size?: number;
    chunk_overlap?: number;
  };
  pdf?: {
    parser?: string;
  };
  general?: {
    preferredEditor?: string;
  };
  data_paths?: Record<string, string>;
  csv_sources?: Record<string, unknown>;
  json_sources?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Chat events (server → client via SSE) ────────────────────────

export type ToolStepStatus = "executing" | "complete";
export type ActivityStepKind = "tool" | "reflection";

export interface FileDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
}

export interface ChatEvent {
  type:
    | "accepted"
    | "status"
    | "reflection"
    | "tool_call"
    | "tool_result"
    | "response"
    | "error"
    | "approval_request"
    | "session_title";
  name?: string;
  args?: Record<string, unknown>;
  output?: string;
  /** Bounded terminal-safe version of output; GUI clients should use output. */
  output_preview?: string;
  content?: string;
  message?: string;
  title?: string;
  retry_after?: number | null;
  // Approval request fields
  approval_id?: string;
  tool_name?: string;
  diffs?: FileDiffEntry[];
}

/**
 * Enriched tool step used by the ActivityLog component.
 * Built from pairs of tool_call + tool_result events.
 */
export interface ToolStep {
  kind?: ActivityStepKind;
  name: string;
  args: Record<string, unknown>;
  status: ToolStepStatus;
  output?: string;
  reflection?: string;
}

// ── File attachments ─────────────────────────────────────────────

export interface Attachment {
  path: string;
  name: string;
}
export interface ChatImage {
  id: string; name: string; mime_type: string; width: number; height: number; size: number; url: string;
}

// ── Slash commands ───────────────────────────────────────────────

export interface SlashCommandDef {
  name: string; // e.g. "/help"
  description: string; // shown in dropdown
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/init", description: "Generate workspace skills from directory" },
  { name: "/model", description: "Switch active model (from configured models)" },
  { name: "/resume", description: "Resume a previous chat session" },
  { name: "/editor", description: "Set preferred external editor" },
  { name: "/config", description: "Edit config (/config llm | /config agent)" },
  { name: "/reset", description: "Clear conversation and start new session" },
  { name: "/quit", description: "Exit Scout" },
  { name: "/exit", description: "Exit Scout" },
];

// ── Suggestion (used by both @ and / autocomplete) ───────────────

export interface Suggestion {
  label: string;
  value: string;
  description?: string;
}
