export interface McpTool {
  name: string;
  description?: string;
  read_only?: boolean;
  enabled?: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  transport: string;
  url?: string;
  image?: string;
  enabled: boolean;
  availability: string;
  health?: { status?: string; tool_count?: number; error?: string };
  tools?: McpTool[];
  assigned_user_ids?: number[];
  has_shared_credential?: boolean;
}

export interface UserEntry {
  id: number;
  username: string;
}

export type Transport = "streamable_http" | "container_stdio";

/**
 * Every mutation the MCP tabs can perform.
 *
 * The tabs are presentation; the parent owns the fetches, the confirmations and
 * the single reload. Passing this down rather than a `baseUrl`/`token` pair is
 * what keeps the blast-radius confirmation copy in one place — it is the best
 * writing in the admin area and it must not fork into three tabs that drift.
 */
export interface McpActions {
  toggleServer: (server: McpServer) => void;
  removeServer: (server: McpServer) => void;
  changeAvailability: (server: McpServer, next: string) => void;
  saveSharedCredential: (server: McpServer, credential: string) => Promise<void>;
  assignUser: (server: McpServer, user: UserEntry, assigned: boolean) => void;
  setToolPolicy: (
    server: McpServer,
    tool: McpTool,
    change: { enabled?: boolean; read_only?: boolean },
  ) => void;
  setToolsEnabled: (server: McpServer, tools: McpTool[], enabled: boolean) => void;
}

/**
 * Three states, not two.
 *
 * `health.error` exists on the payload and was rendered nowhere, so a server
 * that failed hard and a server that has simply never been contacted both showed
 * the same grey "not connected" — the difference between "check your token" and
 * "nothing to do yet".
 */
export function serverState(server: McpServer): {
  tone: "success" | "error" | "neutral";
  label: string;
  error?: string;
} {
  if (server.health?.error) {
    return { tone: "error", label: "failed", error: server.health.error };
  }
  if (server.health?.status === "ok") return { tone: "success", label: "connected" };
  return { tone: "neutral", label: server.health?.status ?? "not connected" };
}

/** The id the server will be given, derived from the display name. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
