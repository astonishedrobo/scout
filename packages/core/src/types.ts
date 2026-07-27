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

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Durable lifecycle record rendered inline in the conversation. */
export interface TaskEvent {
  task_id: string;
  task_type: "agent" | "terminal";
  title: string;
  status: TaskStatus;
  created_at?: number;
  started_at?: number;
  finished_at?: number | null;
  summary?: string;
  result_preview?: string;
  error?: string;
}

/** Compact chronological completion signal, separate from a task's live card. */
export interface TaskNotice {
  task_id: string;
  title: string;
  status: TaskStatus;
  summary?: string;
  result_preview?: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  /** A durable background-work lifecycle row. */
  task?: TaskEvent;
  /** Claude-style terminal notification when a background task ends. */
  taskNotice?: TaskNotice;
  /** Completed tool steps (populated after streaming ends). */
  steps?: ToolStep[];
  artifacts?: Artifact[];
  fileChanges?: FileChangeSet[];
  attachments?: string[];
  chatImages?: ChatImage[];
  /** Follow-up annotations attached to this user turn. */
  annotations?: ResponseAnnotation[];
  /** True when the user stopped generation mid-turn; keep partial content. */
  stopped?: boolean;
}

/** A note on a precise excerpt of a previous assistant response. */
export interface ResponseAnnotation {
  id: string;
  /** Stable client-side key for the rendered assistant text block. */
  sourceId: string;
  /** Exact text selected by the user. */
  quote: string;
  /** A little surrounding prose makes repeated quotes unambiguous to the agent. */
  contextBefore?: string;
  contextAfter?: string;
  /** Optional instruction/question supplied by the user. */
  comment: string;
  createdAt: string;
  updatedAt: string;
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

export type ArtifactRenderer = "markdown" | "html" | "image" | "csv" | "json" | "code" | "text" | "pdf";

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

/**
 * `failed` is derived on the client (see `toolFailed` in useChat): the server
 * reports a failed tool as an ordinary result with the error text in `output`,
 * so without this a failed exec_command was pixel-identical to a successful one.
 */
export type ToolStepStatus = "executing" | "complete" | "interrupted" | "failed";
/** Chronological turn blocks. `reflection` is a legacy alias for `thinking`. */
export type ActivityStepKind = "tool" | "thinking" | "text" | "reflection";

export interface FileDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
  /** Approval previews may be shortened; the exact diff is fetched on review. */
  truncated?: boolean;
  original_chars?: number;
}

export type ApprovalMode = "ask_always" | "allow_edits" | "full_access";

export interface FileChangeEntry extends FileDiffEntry {
  old_hash?: string | null;
  new_hash?: string | null;
  old_content_base64?: string | null;
  new_content_base64?: string | null;
  reversible: boolean;
}

export interface FileChangeSet {
  id: string;
  tool_name: string;
  summary: string;
  created_at: string;
  entries: FileChangeEntry[];
  undone?: boolean;
}

export interface CapabilityRequestPayload {
  capability: string;
  reason: string;
  scope: Record<string, unknown>;
  command_summary: string;
}

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: UserInputOption[];
  is_other?: boolean;
}

export interface UserInputRequest {
  request_id: string;
  questions: UserInputQuestion[];
}

export interface ChatEvent {
  type:
    | "accepted"
    | "status"
    | "thinking"
    | "assistant_text"
    | "reflection"
    | "tool_call"
    | "tool_result"
    | "tool_output_chunk"
    | "response_start"
    | "response_reset"
    | "response_delta"
    | "response"
    | "error"
    | "interrupted"
    | "approval_request"
    | "user_input_request"
    | "session_title"
    | "steer_consumed"
    | "steer_rejected";
  session_id?: string;
  turn_id?: string;
  steer_id?: string;
  client_id?: string;
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
  request_id?: string;
  questions?: UserInputQuestion[];
  artifacts?: Artifact[];
  file_changes?: FileChangeSet[];
}

/**
 * Chronological turn step used by the GUI/CLI timeline.
 * Built from thinking / assistant_text / tool_call / tool_result events.
 */
export interface ToolStep {
  kind?: ActivityStepKind;
  name: string;
  args: Record<string, unknown>;
  status: ToolStepStatus;
  output?: string;
  /** Expandable thinking body (and legacy reflection text). */
  reflection?: string;
  /** Thinking header shown when the block is collapsed. */
  title?: string;
  /** Visible mid-turn prose for kind === "text". */
  content?: string;
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
