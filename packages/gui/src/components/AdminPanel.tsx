import { useState, useEffect, useRef } from "react";
import { Upload, Trash2, RefreshCw, Shield, Users, Settings, Plug, Plus, Link2 } from "lucide-react";
import { RightDrawer } from "./ui/RightDrawer";
import { CenterModal } from "./ui/CenterModal";
import { Button } from "./ui/Button";

interface SharedFile {
  path: string;
  size: number;
}

interface UserEntry {
  id: number;
  username: string;
  is_admin: boolean;
  permission_profile: string;
  admission_group: string;
}

interface PriorityGroup {
  priority: number;
  max_concurrent_requests_per_user: number;
}

interface AdminPanelProps {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  token: string | null;
}

interface ExecutionHealth {
  available: boolean;
  backend: string;
  isolation: boolean;
  isolation_tier?: string | null;
  persistent_python?: boolean;
  oneshot?: boolean;
  worker_reachable?: boolean;
  warnings: string[];
  error?: string | null;
}

interface McpServer {
  id: string;
  name: string;
  transport: string;
  url?: string;
  image?: string;
  enabled: boolean;
  availability: string;
  health?: { status?: string; tool_count?: number; error?: string };
  tools?: { name: string; description?: string; read_only?: boolean; enabled?: boolean }[];
  assigned_user_ids?: number[];
  has_shared_credential?: boolean;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AdminPanel({ open, onClose, baseUrl, token }: AdminPanelProps) {
  const [tab, setTab] = useState<"files" | "users" | "execution" | "mcp" | "config">("files");
  const [configInfo, setConfigInfo] = useState<any>(null);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [priorityGroups, setPriorityGroups] = useState<Record<string, PriorityGroup>>({});
  const [execHealth, setExecHealth] = useState<ExecutionHealth | null>(null);
  const [execMetrics, setExecMetrics] = useState<Record<string, number>>({});
  const [admissionMetrics, setAdmissionMetrics] = useState<Record<string, number>>({});
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingExec, setLoadingExec] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"streamable_http" | "container_stdio">("streamable_http");
  const [mcpImage, setMcpImage] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpCredential, setMcpCredential] = useState("");
  const [mcpAvailability, setMcpAvailability] = useState<"everyone" | "selected">("everyone");
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpSharedDrafts, setMcpSharedDrafts] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const loadFiles = async () => {
    setLoadingFiles(true);
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/shared/files`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setSharedFiles(d.files ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/users`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setUsers(d.users ?? []);
      setPriorityGroups(d.priority_groups ?? {});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadExecution = async () => {
    setLoadingExec(true);
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/execution-health`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setExecHealth(d.execution ?? null);
      setExecMetrics(d.metrics ?? {});
      setAdmissionMetrics(d.admission ?? {});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingExec(false);
    }
  };

  const loadConfig = async () => {
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/config/effective`, { headers });
      if (!r.ok) throw new Error(await r.text());
      setConfigInfo(await r.json());
    } catch (e: any) {
      setError(e.message);
    }
  };

  const reloadConfig = async () => {
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/config/reload`, { method: "POST", headers });
      if (!r.ok) throw new Error(await r.text());
      await loadConfig();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const loadMcp = async () => {
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/mcp/servers`, { headers });
      if (!r.ok) throw new Error(await r.text());
      setMcpServers((await r.json()).servers ?? []);
    } catch (e: any) { setError(e.message); }
  };

  const addMcp = async () => {
    if (!mcpName.trim()) return setError("Enter an integration name.");
    if (mcpTransport === "streamable_http" && !mcpUrl.trim()) return setError("Enter an MCP URL.");
    if (mcpTransport === "container_stdio" && !mcpImage.trim()) return setError("Enter a digest-pinned container image.");
    const commandParts = mcpCommand.trim().split(/\s+/).filter(Boolean);
    setMcpSaving(true);
    try {
      const r = await fetch(`${baseUrl}/admin/mcp/servers`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mcpName.trim(),
          id: mcpName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          transport: mcpTransport,
          url: mcpTransport === "streamable_http" ? mcpUrl.trim() : undefined,
          image: mcpTransport === "container_stdio" ? mcpImage.trim() : undefined,
          command: mcpTransport === "container_stdio" && commandParts.length ? [commandParts[0]] : [],
          args: mcpTransport === "container_stdio" ? commandParts.slice(1) : [],
          shared_credential: mcpTransport === "streamable_http" ? mcpCredential.trim() || undefined : undefined,
          availability: mcpAvailability,
          enabled: true,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? await r.text());
      setMcpName(""); setMcpUrl(""); setMcpImage(""); setMcpCommand(""); setMcpCredential(""); setMcpTransport("streamable_http"); setMcpAvailability("everyone"); await loadMcp();
    } catch (e: any) { setError(e.message); } finally { setMcpSaving(false); }
  };

  const toggleMcp = async (server: McpServer) => {
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !server.enabled }) });
    if (!r.ok) setError(await r.text()); else await loadMcp();
  };

  const removeMcp = async (server: McpServer) => {
    if (!window.confirm(`Remove ${server.name}?`)) return;
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, { method: "DELETE", headers });
    if (!r.ok) setError(await r.text()); else await loadMcp();
  };

  const setMcpAvailabilityFor = async (server: McpServer, availability: "everyone" | "selected") => {
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ availability }),
    });
    if (!r.ok) setError(await r.text()); else await loadMcp();
  };

  const setMcpUser = async (server: McpServer, userId: number, assigned: boolean) => {
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}/users/${userId}`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ assigned }),
    });
    if (!r.ok) setError(await r.text()); else await loadMcp();
  };

  const setMcpToolPolicy = async (server: McpServer, tool: NonNullable<McpServer["tools"]>[number], change: { enabled?: boolean; read_only?: boolean }) => {
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}/tools/${encodeURIComponent(tool.name)}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    if (!r.ok) setError(await r.text()); else await loadMcp();
  };

  const saveMcpSharedCredential = async (server: McpServer) => {
    const credential = mcpSharedDrafts[server.id]?.trim();
    if (!credential) return;
    const r = await fetch(`${baseUrl}/admin/mcp/servers/${server.id}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ shared_credential: credential }),
    });
    if (!r.ok) setError(await r.text());
    else {
      setMcpSharedDrafts((current) => ({ ...current, [server.id]: "" }));
      await loadMcp();
    }
  };

  useEffect(() => {
    if (!open) return;
    if (tab === "files") loadFiles();
    else if (tab === "users") loadUsers();
    else if (tab === "execution") loadExecution();
    else if (tab === "mcp") { loadMcp(); loadUsers(); }
    else loadConfig();
  }, [open, tab]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const r = await fetch(`${baseUrl}/upload?target=shared`, {
          method: "POST",
          headers,
          body: form,
        });
        if (!r.ok) throw new Error(await r.text());
      }
      await loadFiles();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (path: string) => {
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/shared/files?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
        headers,
      });
      if (!r.ok) throw new Error(await r.text());
      await loadFiles();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      handleDelete(deleteTarget);
      setDeleteTarget(null);
    }
  };

  const handleProfileChange = async (u: UserEntry, profile: string) => {
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/users/${u.id}/profile`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ permission_profile: profile }),
      });
      if (!r.ok) {
        const d = await r.json().catch(async () => ({ detail: await r.text() }));
        throw new Error(d.detail ?? "Failed");
      }
      await loadUsers();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleAdmissionGroupChange = async (u: UserEntry, admissionGroup: string) => {
    setError(null);
    try {
      const r = await fetch(`${baseUrl}/admin/users/${u.id}/admission-group`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ admission_group: admissionGroup }),
      });
      if (!r.ok) {
        const d = await r.json().catch(async () => ({ detail: await r.text() }));
        throw new Error(d.detail ?? "Failed");
      }
      await loadUsers();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <>
    <RightDrawer open={open} onClose={onClose} title="Admin" width={480}>
        <div className="flex border-b border-scout-hairline">
          {(["files", "users", "execution", "mcp", "config"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-[13px] transition-colors flex items-center justify-center gap-1.5 border-b-2 -mb-px
                ${tab === t ? "border-scout-text text-scout-text font-semibold" : "border-transparent font-medium text-scout-muted hover:text-scout-text"}`}
            >
              {t === "files" ? <Upload size={14} /> : t === "users" ? <Users size={14} /> : t === "execution" ? <Shield size={14} /> : t === "mcp" ? <Plug size={14} /> : <Settings size={14} />}
              {t === "files" ? "Files" : t === "users" ? "Users" : t === "execution" ? "Execution" : t === "mcp" ? "Tools" : "Config"}
            </button>
          ))}
        </div>

        {error && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-btn bg-scout-error-muted border border-scout-error/20 text-xs text-scout-error">
            {error}
          </div>
        )}

        <div className="px-5 py-4">
          {tab === "files" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-pill bg-scout-text
                             text-scout-bg hover:opacity-90 text-[13px] font-semibold transition-all disabled:opacity-40"
                >
                  <Upload size={14} /> {uploading ? "Uploading…" : "Upload to Shared"}
                </button>
                <button
                  onClick={loadFiles}
                  disabled={loadingFiles}
                  className="p-2 rounded-btn hover:bg-scout-lift text-scout-muted hover:text-scout-text transition-colors"
                  title="Refresh"
                >
                  <RefreshCw size={14} className={loadingFiles ? "animate-spin" : ""} />
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleUpload(e.target.files)}
              />
              {sharedFiles.length === 0 ? (
                <p className="text-xs text-scout-muted/60 py-6 text-center">
                  No files in shared repo yet
                </p>
              ) : (
                <div className="space-y-1">
                  {sharedFiles.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-scout-lift group">
                      <span className="flex-1 text-xs font-mono text-scout-text truncate">{f.path}</span>
                      <span className="text-[11px] font-medium text-scout-muted shrink-0">{fmtSize(f.size)}</span>
                      <button
                  onClick={() => setDeleteTarget(f.path)}
                  className="hover-reveal p-1.5 rounded-btn text-scout-error"
                  title="Delete"
                >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "users" && (
            <div className="space-y-2">
              <p className="text-xs text-scout-muted leading-relaxed">
                Access controls permissions. Capacity groups control queue preference and the maximum simultaneous agent turns per user.
              </p>
              <button
                onClick={loadUsers}
                disabled={loadingUsers}
                className="flex items-center gap-1.5 p-2 rounded-btn hover:bg-scout-lift text-scout-muted hover:text-scout-text transition-colors mb-1"
                title="Refresh"
              >
                <RefreshCw size={14} className={loadingUsers ? "animate-spin" : ""} />
              </button>
              {users.length === 0 ? (
                <p className="text-xs text-scout-muted/60 py-6 text-center">No users found</p>
              ) : (
                <div className="space-y-1">
                  {users.map((u) => (
                    <div key={u.id} className="px-3 py-2.5 rounded-xl hover:bg-scout-lift space-y-2">
                      <div className="flex items-center gap-3">
                        <span className="flex-1 text-sm text-scout-text font-medium">{u.username}</span>
                        <span className="text-[11px] font-medium text-scout-muted">#{u.id}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                          <span className="text-[10px] uppercase tracking-wide text-scout-muted">Access</span>
                          <select
                            value={u.permission_profile ?? (u.is_admin ? "admin" : "contributor")}
                            onChange={(e) => handleProfileChange(u, e.target.value)}
                            className="w-full text-xs font-medium bg-scout-input-bg border border-scout-hairline-faint rounded-lg px-2 py-1.5 text-scout-text outline-none focus:border-scout-text/30"
                          >
                            <option value="analyst">Analyst</option>
                            <option value="contributor">Contributor</option>
                            <option value="admin">Admin</option>
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] uppercase tracking-wide text-scout-muted">Capacity</span>
                          <select
                            value={u.admission_group || "standard"}
                            onChange={(e) => handleAdmissionGroupChange(u, e.target.value)}
                            className="w-full text-xs font-medium bg-scout-input-bg border border-scout-hairline-faint rounded-lg px-2 py-1.5 text-scout-text outline-none focus:border-scout-text/30"
                          >
                            {Object.entries(priorityGroups).map(([name, group]) => (
                              <option key={name} value={name}>
                                {name} · {group.max_concurrent_requests_per_user} turns
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "execution" && (
            <div className="space-y-3">
              <button
                onClick={loadExecution}
                disabled={loadingExec}
                className="flex items-center gap-1.5 p-2 rounded-btn hover:bg-scout-lift text-scout-muted hover:text-scout-text transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} className={loadingExec ? "animate-spin" : ""} />
              </button>
              {execHealth ? (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${execHealth.available ? "bg-scout-success" : "bg-scout-error"}`} />
                    <span className="font-medium text-scout-text">
                      {execHealth.available ? "Available" : "Unavailable"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-scout-muted">Backend</span>
                      <p className="font-mono text-scout-text">{execHealth.backend}</p>
                    </div>
                    <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-scout-muted">Isolation</span>
                      <p className="font-mono">
                        {execHealth.isolation
                          ? execHealth.isolation_tier
                            ? `${execHealth.isolation_tier}`
                            : "yes"
                          : `disabled${execHealth.isolation_tier ? ` (${execHealth.isolation_tier})` : ""}`}
                      </p>
                    </div>
                    <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-scout-muted">Persistent Python</span>
                      <p className="font-mono">{execHealth.persistent_python ? "ok" : "fail"}</p>
                    </div>
                    <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-scout-muted">Worker</span>
                      <p className="font-mono">{execHealth.worker_reachable ? "reachable" : "down"}</p>
                    </div>
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-scout-muted uppercase tracking-wider">Agent turn capacity</span>
                    <div className="grid grid-cols-2 gap-2 mt-1.5 text-xs">
                      <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                        <span className="text-[11px] text-scout-muted">Active</span>
                        <p className="font-mono text-scout-text">
                          {admissionMetrics.active_requests ?? 0} / {admissionMetrics.max_concurrent_requests ?? 0}
                        </p>
                      </div>
                      <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                        <span className="text-[11px] text-scout-muted">Queued</span>
                        <p className="font-mono text-scout-text">{admissionMetrics.queued_requests ?? 0}</p>
                      </div>
                      <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                        <span className="text-[11px] text-scout-muted">Average wait</span>
                        <p className="font-mono text-scout-text">{admissionMetrics.average_queue_wait_seconds ?? 0}s</p>
                      </div>
                      <div className="bg-scout-canvas rounded-xl p-3 border border-scout-hairline-faint">
                        <span className="text-[11px] text-scout-muted">Rejected / timed out</span>
                        <p className="font-mono text-scout-text">
                          {admissionMetrics.rejected_requests_total ?? 0} / {admissionMetrics.timed_out_requests_total ?? 0}
                        </p>
                      </div>
                    </div>
                  </div>
                  {execHealth.error && (
                    <p className="text-xs text-scout-error">{execHealth.error}</p>
                  )}
                  {execHealth.warnings?.map((w, i) => (
                    <p key={i} className="text-xs text-scout-warning">{w}</p>
                  ))}
                  {Object.keys(execMetrics).length > 0 && (
                    <div>
                      <span className="text-[11px] font-semibold text-scout-muted uppercase tracking-wider">Metrics</span>
                      <pre className="text-xs font-mono bg-scout-input-bg rounded-xl p-3 mt-1.5 border border-scout-hairline-faint">
                        {JSON.stringify(execMetrics, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-scout-muted/60 py-6 text-center">
                  {loadingExec ? "Loading…" : "No execution health data"}
                </p>
              )}
            </div>
          )}

          {tab === "mcp" && (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-scout-text">MCP integrations</h2>
                <p className="text-xs text-scout-muted mt-1">Install a remote MCP server. Users can enable allowed integrations in Settings.</p>
              </div>
              <div className="space-y-2 rounded-xl border border-scout-hairline-faint p-3">
                <input value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="Integration name" className="w-full px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none" />
                <select value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as "streamable_http" | "container_stdio")} className="w-full px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none">
                  <option value="streamable_http">Remote · Streamable HTTP</option>
                  <option value="container_stdio">Container · isolated stdio</option>
                </select>
                <div className="flex gap-2">
                  {mcpTransport === "streamable_http"
                    ? <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="https://example.com/mcp" className="flex-1 px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none" />
                    : <input value={mcpImage} onChange={(e) => setMcpImage(e.target.value)} placeholder="image@sha256:…" className="flex-1 px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none" />}
                  <Button onClick={addMcp} disabled={mcpSaving}><Plus size={13} /> Add</Button>
                </div>
                {mcpTransport === "streamable_http"
                  ? <input type="password" value={mcpCredential} onChange={(e) => setMcpCredential(e.target.value)} placeholder="Shared API token (optional)" className="w-full px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none" />
                  : <input value={mcpCommand} onChange={(e) => setMcpCommand(e.target.value)} placeholder="Command and arguments (optional)" className="w-full px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none" />}
                <select value={mcpAvailability} onChange={(e) => setMcpAvailability(e.target.value as "everyone" | "selected")} className="w-full px-2.5 py-2 rounded-lg bg-scout-input-bg text-xs text-scout-text outline-none">
                  <option value="everyone">Available to everyone</option>
                  <option value="selected">Selected users only</option>
                </select>
              </div>
              <div className="space-y-2">
                {mcpServers.length === 0 ? <p className="text-xs text-scout-muted/70 py-5 text-center">No MCP integrations installed.</p> : mcpServers.map((server) => (
                  <div key={server.id} className="rounded-xl border border-scout-hairline-faint p-3 space-y-2">
                    <div className="flex items-center gap-2"><Link2 size={14} className="text-scout-muted" /><span className="flex-1 text-sm font-medium text-scout-text">{server.name}</span><span className="text-[11px] text-scout-muted">{server.health?.status ?? "not connected"}</span><button onClick={() => toggleMcp(server)} className={`w-8 h-4 rounded-full ${server.enabled ? "bg-scout-success" : "bg-scout-hairline"}`}><span className={`block w-3 h-3 rounded-full bg-white transition-transform ${server.enabled ? "translate-x-4" : "translate-x-0.5"}`} /></button></div>
                    <p className="text-[11px] text-scout-muted truncate">{server.url ?? server.image ?? server.id} · {server.tools?.length ?? 0} tools</p>
                    <select value={server.availability} onChange={(e) => setMcpAvailabilityFor(server, e.target.value as "everyone" | "selected")} className="w-full px-2 py-1.5 rounded-lg bg-scout-input-bg text-[11px] text-scout-text outline-none">
                      <option value="everyone">Available to everyone</option>
                      <option value="selected">Selected users only</option>
                    </select>
                    {server.transport === "streamable_http" && (
                      <div className="flex gap-1.5">
                        <input type="password" value={mcpSharedDrafts[server.id] ?? ""} onChange={(e) => setMcpSharedDrafts((current) => ({ ...current, [server.id]: e.target.value }))} placeholder={server.has_shared_credential ? "Replace shared token" : "Shared token (optional)"} className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-scout-input-bg text-[11px] text-scout-text outline-none" />
                        <Button variant="outline" onClick={() => saveMcpSharedCredential(server)} disabled={!mcpSharedDrafts[server.id]?.trim()}>Save</Button>
                      </div>
                    )}
                    {server.availability === "selected" && (
                      <div className="flex flex-wrap gap-1.5">
                        {users.map((user) => {
                          const assigned = server.assigned_user_ids?.includes(user.id) ?? false;
                          return <button key={user.id} onClick={() => setMcpUser(server, user.id, !assigned)} className={`px-2 py-1 rounded-pill text-[10px] border ${assigned ? "border-scout-success/40 text-scout-success bg-scout-success/10" : "border-scout-hairline text-scout-muted"}`}>{user.username}</button>;
                        })}
                      </div>
                    )}
                    {!!server.tools?.length && (
                      <div className="space-y-1 border-t border-scout-hairline-faint pt-2">
                        {server.tools.map((tool) => (
                          <div key={tool.name} className="flex items-center gap-2 text-[10px]">
                            <span className="flex-1 truncate text-scout-muted" title={tool.description}>{tool.name}</span>
                            <button onClick={() => setMcpToolPolicy(server, tool, { read_only: !tool.read_only })} className={`px-1.5 py-0.5 rounded ${tool.read_only ? "text-scout-success bg-scout-success/10" : "text-scout-muted bg-scout-input-bg"}`}>{tool.read_only ? "read-only" : "write"}</button>
                            <button onClick={() => setMcpToolPolicy(server, tool, { enabled: !tool.enabled })} className={`px-1.5 py-0.5 rounded ${tool.enabled ? "text-scout-text bg-scout-input-bg" : "text-scout-muted/60 bg-scout-input-bg"}`}>{tool.enabled ? "on" : "off"}</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button onClick={() => removeMcp(server)} className="text-[11px] text-scout-error hover:underline">Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === "config" && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Button variant="filled" surface="panel" onClick={reloadConfig}>Reload config</Button>
                <button onClick={loadConfig} className="p-2 rounded-btn text-scout-muted hover:text-scout-text">
                  <RefreshCw size={14} />
                </button>
              </div>
              <p className="text-xs text-scout-muted">Read-only operator configuration. Reloaded values apply to new conversations.</p>
              {configInfo && (
                <>
                  <div className="text-xs text-scout-muted">
                    <p>Source: <span className="font-mono text-scout-text">{configInfo.source}</span></p>
                    <p>Version: <span className="font-mono text-scout-text">{configInfo.version}</span></p>
                  </div>
                  <pre className="text-xs font-mono bg-scout-input-bg rounded-xl p-3 border border-scout-hairline-faint overflow-auto max-h-[55vh]">
                    {JSON.stringify(configInfo.config, null, 2)}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
    </RightDrawer>

    <CenterModal
      open={!!deleteTarget}
      onClose={() => setDeleteTarget(null)}
      title="Delete shared file"
      maxWidth="sm"
    >
      <div className="px-5 py-4 space-y-4">
        <p className="text-sm text-scout-muted">
          Delete shared/{deleteTarget}? This cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" surface="panel" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button variant="filled" surface="panel" onClick={confirmDelete}>
            Delete
          </Button>
        </div>
      </div>
    </CenterModal>
    </>
  );
}
