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

// ── Chat messages ────────────────────────────────────────────────

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Completed tool steps (populated after streaming ends). */
  steps?: ToolStep[];
  artifacts?: Artifact[];
  attachments?: string[];
  chatImages?: ChatImage[];
}

export type VisionSupport = "supported" | "unsupported" | "unverified";
export interface ChatImage {
  id: string;
  name: string;
  mime_type: string;
  width: number;
  height: number;
  size: number;
  url: string;
}

export type ArtifactRenderer = "markdown" | "html" | "image" | "csv" | "json" | "code" | "text";

export interface Artifact {
  id: string;
  path: string;
  name: string;
  title: string;
  mime_type: string;
  renderer: ArtifactRenderer;
  size: number;
  version: string;
  presentation: "inline" | "panel" | "both";
}

// ── Chat events (server → client via SSE) ────────────────────────

export type ToolStepStatus = "executing" | "complete";

export interface FileDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
}

export interface CapabilityRequestPayload {
  capability: string;
  reason: string;
  scope: Record<string, unknown>;
  command_summary: string;
}

export interface ChatEvent {
  type: "accepted" | "status" | "tool_call" | "tool_result" | "tool_output_chunk" | "response" | "error" | "approval_request" | "session_title";
  session_id?: string;
  name?: string;
  args?: Record<string, unknown>;
  output?: string;
  /** Bounded terminal-safe version of output; GUI clients should use output. */
  output_preview?: string;
  tool_call_id?: string;
  process_id?: number;
  chunk?: string;
  content?: string;
  message?: string;
  title?: string;
  retry_after?: number | null;
  // Approval request fields
  approval_id?: string;
  kind?: "file_changes" | "capability" | "execution_promotion" | "permission_elevation";
  tool_name?: string;
  diffs?: FileDiffEntry[];
  capability?: CapabilityRequestPayload;
  permission_request?: { reason: string; network_domains?: string[] };
  can_share?: boolean;
  artifacts?: Artifact[];
}

/**
 * Enriched tool step used by the ActivityLog component.
 * Built from pairs of tool_call + tool_result events.
 */
export interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  status: ToolStepStatus;
  output?: string;
}

// ── File attachments ─────────────────────────────────────────────

export interface Attachment {
  path: string;
  name: string;
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
  { name: "/memory", description: "Manage cross-session memories" },
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
