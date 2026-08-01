/** Resumable, interactive Docker deployment wizard. */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m" };
const DRAFT_DIR = ".scout/deployment";

export type DeployAction = "setup" | "launch" | "restart" | "rebuild" | "status" | "logs";

export type ProviderId = "openai" | "groq" | "anthropic" | "vllm";
export const PROVIDER_IDS: ProviderId[] = ["openai", "groq", "anthropic", "vllm"];

export type VisionCapability = "supported" | "unsupported" | "unverified";

export interface VllmRuntimeConfig {
  image: string;
  gpuMemoryUtilization: string;
  maxModelLen: string;
  tensorParallelSize: number;
  quantization: string;
  gpuDevices: string;
  toolCallParser: string;
  reasoningParser: string;
}

export interface AgentDeploymentConfig {
  temperature: string;
  maxIterations: number;
  providerMaxRetries: number;
  codeTimeout: number;
}

export interface ServerDeploymentConfig {
  maxLiveSessions: number;
  maxLiveSessionsPerUser: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  maxQueuedRequestsPerUser: number;
  requestQueueTimeoutSeconds: number;
}

export interface ExecutionDeploymentConfig {
  enabled: boolean;
  networkDefault: "deny" | "allow_domains";
  timeoutSeconds: number;
  maxMemoryMb: number;
  maxProcesses: number;
}

export interface MultiAgentDeploymentConfig {
  enabled: boolean;
  maxConcurrent: number;
  maxIterations: number;
  defaultBackground: boolean;
  autoContinueOnComplete: boolean;
}

export interface ProviderConfig {
  /** Fully-qualified IDs for API providers; raw Hugging Face IDs for vLLM. */
  models: string[];
  apiKey: string;
  /** Empty means the wizard manages local vLLM service(s). */
  apiBase: string;
}

export interface McpBootstrapServer {
  id: string;
  name: string;
  transport: "streamable_http" | "container_stdio";
  url?: string;
  image?: string;
  command?: string[];
  args?: string[];
  availability: "everyone" | "selected";
  enabled: boolean;
  auth_mode: "none" | "bearer";
}

export interface DeploymentDraft {
  version: 4;
  phase: "providers" | "models" | "access" | "mcp" | "review" | "complete";
  /** Providers the user enabled, in configuration order. */
  enabled: ProviderId[];
  providers: Record<ProviderId, ProviderConfig>;
  /** Fully-qualified default model id (hosted_vllm/… for vllm). */
  defaultModel: string;
  port: number;
  adminUsers: string;
  /** Host directory holding users/ + shared/ (absolute or repo-relative). */
  workspaceRoot: string;
  /** Host directory for server data; "" = Docker-managed volume. */
  dataDir: string;
  bindAddress: string;
  visionCapabilities: Record<string, VisionCapability>;
  vllmRuntime: VllmRuntimeConfig;
  agent: AgentDeploymentConfig;
  server: ServerDeploymentConfig;
  execution: ExecutionDeploymentConfig;
  multiAgent: MultiAgentDeploymentConfig;
  scoutSecret: string;
  workerSecret: string;
  /** Admin-installed MCP integrations applied by the deploy wizard. */
  mcpServers: McpBootstrapServer[];
  updatedAt: string;
}

type DeploymentDraftV2 = Omit<DeploymentDraft, "version" | "mcpServers"> & { version: 2 };
type DeploymentDraftV3 = Omit<DeploymentDraft, "version"> & { version: 3 };

/** V1 single-provider draft, still accepted on load. */
interface DeploymentDraftV1 {
  version: 1;
  model: string;
  provider: ProviderId;
  port: number;
  adminUsers: string;
  openaiApiKey: string;
  groqApiKey: string;
  anthropicApiKey: string;
  scoutSecret: string;
  workerSecret: string;
  updatedAt: string;
}

/** Fully-qualified model id as the agent/config sees it. */
export function modelId(provider: ProviderId, model: string): string {
  return provider === "vllm" ? `hosted_vllm/${model}` : model;
}

const DEFAULT_VLLM_RUNTIME: VllmRuntimeConfig = {
  image: "vllm/vllm-openai:v0.10.1",
  gpuMemoryUtilization: "0.90",
  maxModelLen: "",
  tensorParallelSize: 1,
  quantization: "",
  gpuDevices: "all",
  toolCallParser: "hermes",
  reasoningParser: "qwen3",
};

export function deploymentDraftPath(root: string): string { return join(root, DRAFT_DIR, "draft.json"); }

export function newDeploymentDraft(): DeploymentDraft {
  return {
    version: 4,
    phase: "providers",
    enabled: [],
    providers: {
      openai: { models: ["openai/gpt-5-mini"], apiKey: "", apiBase: "" },
      groq: { models: ["groq/llama-3.1-8b-instant"], apiKey: "", apiBase: "" },
      anthropic: { models: [], apiKey: "", apiBase: "" },
      vllm: { models: ["Qwen/Qwen3-0.6B"], apiKey: "", apiBase: "" },
    },
    defaultModel: "",
    port: 4200,
    adminUsers: "",
    workspaceRoot: "./workspace",
    dataDir: "",
    bindAddress: "0.0.0.0",
    visionCapabilities: {},
    vllmRuntime: { ...DEFAULT_VLLM_RUNTIME },
    agent: { temperature: "0.2", maxIterations: 25, providerMaxRetries: 2, codeTimeout: 30 },
    server: {
      maxLiveSessions: 64,
      maxLiveSessionsPerUser: 8,
      maxConcurrentRequests: 8,
      maxQueuedRequests: 256,
      maxQueuedRequestsPerUser: 16,
      requestQueueTimeoutSeconds: 60,
    },
    execution: { enabled: true, networkDefault: "deny", timeoutSeconds: 60, maxMemoryMb: 1024, maxProcesses: 64 },
    multiAgent: { enabled: true, maxConcurrent: 3, maxIterations: 10, defaultBackground: true, autoContinueOnComplete: true },
    scoutSecret: randomBytes(32).toString("hex"),
    workerSecret: randomBytes(32).toString("hex"),
    mcpServers: [],
    updatedAt: new Date().toISOString(),
  };
}

function migrateDraft(v1: DeploymentDraftV1): DeploymentDraft {
  const draft = newDeploymentDraft();
  draft.enabled = [v1.provider];
  draft.providers[v1.provider] = {
    models: v1.model ? [v1.model] : [],
    apiKey: v1.provider === "openai" ? v1.openaiApiKey : v1.provider === "groq" ? v1.groqApiKey : v1.provider === "anthropic" ? v1.anthropicApiKey : "",
    apiBase: "",
  };
  draft.defaultModel = modelId(v1.provider, v1.model);
  draft.port = v1.port;
  draft.adminUsers = v1.adminUsers;
  draft.scoutSecret = v1.scoutSecret;
  draft.workerSecret = v1.workerSecret;
  return draft;
}

function migrateDraftV3(value: DeploymentDraftV3): DeploymentDraft {
  const draft = newDeploymentDraft();
  const source = value as unknown as { providers?: Record<string, Record<string, unknown>> };
  Object.assign(draft, value);
  draft.version = 4;
  draft.providers = { ...draft.providers };
  for (const id of PROVIDER_IDS) {
    const old = source.providers?.[id];
    if (!old) continue;
    const oldModel = typeof old.model === "string" ? old.model : "";
    draft.providers[id] = {
      models: Array.isArray(old.models)
        ? old.models.filter((model): model is string => typeof model === "string")
        : oldModel ? [oldModel] : [],
      apiKey: typeof old.apiKey === "string" ? old.apiKey : "",
      apiBase: typeof old.apiBase === "string" ? old.apiBase : "",
    };
  }
  draft.bindAddress = value.bindAddress ?? "0.0.0.0";
  draft.visionCapabilities = value.visionCapabilities ?? {};
  draft.vllmRuntime = { ...DEFAULT_VLLM_RUNTIME, ...((value as unknown as Partial<DeploymentDraft>).vllmRuntime ?? {}) };
  draft.agent = value.agent ?? newDeploymentDraft().agent;
  draft.server = value.server ?? newDeploymentDraft().server;
  draft.execution = value.execution ?? newDeploymentDraft().execution;
  draft.multiAgent = value.multiAgent ?? newDeploymentDraft().multiAgent;
  return draft;
}

function discardUncommittedProviderVisits(draft: DeploymentDraft): DeploymentDraft {
  // Older wizard builds enabled a provider as soon as its menu was opened.
  // When resuming an unfinished draft, discard those untouched visits so an
  // inspection of a blank provider cannot lock Review.
  if (draft.phase === "complete") return draft;
  const factory = newDeploymentDraft();
  draft.enabled = draft.enabled.filter((id) => {
    const provider = draft.providers[id];
    const defaults = factory.providers[id].models;
    return !!provider.apiKey || !!provider.apiBase || provider.models.some((model) => !defaults.includes(model));
  });
  return draft;
}

function saveDraft(root: string, draft: DeploymentDraft): void {
  const path = deploymentDraftPath(root);
  mkdirSync(resolve(path, ".."), { recursive: true });
  draft.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
}

function loadMcpBootstrap(root: string): McpBootstrapServer[] {
  const path = join(root, "config", "mcp.yaml");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { servers?: McpBootstrapServer[] };
    return Array.isArray(parsed.servers) ? parsed.servers : [];
  } catch {
    return [];
  }
}

function loadDraft(root: string): DeploymentDraft | undefined {
  const path = deploymentDraftPath(root);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as DeploymentDraft | DeploymentDraftV3 | DeploymentDraftV2 | DeploymentDraftV1;
    if (value.version === 4) return discardUncommittedProviderVisits({ ...newDeploymentDraft(), ...value });
    if (value.version === 3) return discardUncommittedProviderVisits(migrateDraftV3(value));
    if (value.version === 2) {
      const migrated = migrateDraftV3({ ...value, version: 3 } as DeploymentDraftV3);
      migrated.mcpServers = loadMcpBootstrap(root);
      return discardUncommittedProviderVisits(migrated);
    }
    if (value.version === 1) return migrateDraft(value);
    return undefined;
  } catch { return undefined; }
}

function check(command: string, args: string[]): boolean { return spawnSync(command, args, { stdio: "ignore" }).status === 0; }

function composeCommand(): [string, string[]] | null {
  if (check("docker", ["compose", "version"])) return ["docker", ["compose"]];
  if (check("docker-compose", ["version"])) return ["docker-compose", []];
  return null;
}

function supportsBuildx(): boolean {
  const result = spawnSync("docker", ["buildx", "version"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const match = `${result.stdout}${result.stderr}`.match(/v(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major! > 0 || minor! >= 17;
}

function hasNvidiaRuntime(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{json .Runtimes.nvidia}}"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "" && result.stdout.trim() !== "null";
}

function preflight(): { docker: boolean; compose: boolean; gpu: boolean; nvidiaRuntime: boolean } {
  return { docker: check("docker", ["version"]), compose: composeCommand() !== null, gpu: check("nvidia-smi", ["-L"]), nvidiaRuntime: hasNvidiaRuntime() };
}

function requireDocker(root: string): void {
  if (!check("docker", ["version"]) || !composeCommand()) throw new Error("Docker Engine and Docker Compose (v2 `docker compose` or v1 `docker-compose`) are required. Install one, then run scout deploy --resume.");
  if (!existsSync(join(root, "docker-compose.yml"))) throw new Error(`No docker-compose.yml found in ${root}. Run this from the Scout repository root.`);
}

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) { const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (match) values.set(match[1]!, match[2]!); }
  return values;
}

/**
 * Seed a draft from the current .env so re-running the wizard starts
 * from what is already deployed (same secrets, provider, model, port)
 * instead of factory defaults.
 */
const PROVIDER_ENV_KEYS: Record<ProviderId, string[]> = {
  openai: ["OPENAI_API_KEY", "OPENAI_MODELS", "OPENAI_API_BASE"],
  groq: ["GROQ_API_KEY", "GROQ_MODELS", "GROQ_API_BASE"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODELS", "ANTHROPIC_API_BASE"],
  vllm: ["VLLM_MODEL", "VLLM_API_KEY", "VLLM_MODELS", "VLLM_API_BASE"],
};

export function draftFromEnvironment(root: string, env?: Map<string, string>): DeploymentDraft {
  const draft = newDeploymentDraft();
  draft.mcpServers = loadMcpBootstrap(root);
  if (!env) {
    const envPath = join(root, ".env");
    if (!existsSync(envPath)) return draft;
    env = parseEnv(readFileSync(envPath, "utf8"));
  }
  const get = (key: string) => env!.get(key) ?? "";
  if (/^\d+$/.test(get("SCOUT_PORT"))) draft.port = Number(get("SCOUT_PORT"));
  if (get("SCOUT_ADMIN_USERS")) draft.adminUsers = get("SCOUT_ADMIN_USERS");
  if (get("SCOUT_WORKSPACE_ROOT")) draft.workspaceRoot = get("SCOUT_WORKSPACE_ROOT");
  if (get("SCOUT_DATA_DIR")) draft.dataDir = get("SCOUT_DATA_DIR");
  if (get("SCOUT_SECRET_KEY")) draft.scoutSecret = get("SCOUT_SECRET_KEY");
  if (get("SCOUT_WORKER_SECRET")) draft.workerSecret = get("SCOUT_WORKER_SECRET");

  const parseModels = (raw: string) => raw.split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ["openai", "groq", "anthropic"] as const) {
    const key = get(`${id.toUpperCase()}_API_KEY`);
    if (!key) continue;
    const models = get(`${id.toUpperCase()}_MODELS`);
    if (models) draft.providers[id].models = parseModels(models);
    draft.providers[id].apiKey = key;
    draft.providers[id].apiBase = get(`${id.toUpperCase()}_API_BASE`);
    // A key alone is not a deployable provider. In particular, Anthropic has
    // no factory model, so a key with an empty model catalog must not lock the
    // wizard until the user explicitly configures that provider.
    if (!draft.providers[id].models.length) continue;
    draft.enabled.push(id);
  }
  const vllmModels = parseModels(get("VLLM_MODELS")).map((model) => model.replace(/^hosted_vllm\//, ""));
  if (vllmModels.length || get("VLLM_MODEL")) {
    draft.enabled.push("vllm");
    draft.providers.vllm.models = vllmModels.length ? vllmModels : [get("VLLM_MODEL")];
    draft.providers.vllm.apiBase = get("VLLM_API_BASE");
  }

  // Local managed vLLM deployments intentionally do not write generic
  // VLLM_MODELS variables, because those variables would shadow the distinct
  // provider endpoints generated for each model. Recover the catalog from the
  // generated YAML when a saved draft is unavailable.
  const configPath = join(root, "config", "scout.yaml");
  if (existsSync(configPath)) {
    try {
      const parsed = yaml.load(readFileSync(configPath, "utf8")) as { llm?: { providers?: Record<string, { models?: unknown; api_base?: unknown }> }; agent?: { model?: unknown }; model_capabilities?: Record<string, { vision?: VisionCapability }> };
      const configured = parsed.llm?.providers ?? {};
      for (const id of ["openai", "groq", "anthropic"] as const) {
        const provider = configured[id];
        if (draft.enabled.includes(id) && !get(`${id.toUpperCase()}_MODELS`) && Array.isArray(provider?.models)) {
          draft.providers[id].models = provider.models.filter((model): model is string => typeof model === "string");
        }
      }
      const localEntries = Object.entries(configured).filter(([name]) => name === "vllm" || name.startsWith("vllm_"));
      if (!draft.providers.vllm.models.length || !draft.enabled.includes("vllm")) {
        const models = localEntries.flatMap(([, provider]) => Array.isArray(provider.models) ? provider.models : []).filter((model): model is string => typeof model === "string").map((model) => model.replace(/^hosted_vllm\//, ""));
        if (models.length) {
          draft.enabled.push("vllm");
          draft.providers.vllm.models = [...new Set(models)];
          const external = configured.vllm?.api_base;
          draft.providers.vllm.apiBase = typeof external === "string" ? external : "";
        }
      }
      if (!get("SCOUT_DEFAULT_MODEL") && typeof parsed.agent?.model === "string") draft.defaultModel = parsed.agent.model;
      for (const [model, capability] of Object.entries(parsed.model_capabilities ?? {})) {
        if (capability.vision) draft.visionCapabilities[model] = capability.vision;
      }
    } catch {
      // A malformed config is reported by the deployment itself; keep the
      // environment-derived draft usable so the wizard can repair it.
    }
  }

  const fallback = draft.enabled[0];
  draft.bindAddress = get("SCOUT_BIND_ADDRESS") || draft.bindAddress;
  draft.defaultModel = get("SCOUT_DEFAULT_MODEL") || draft.defaultModel || (fallback ? modelId(fallback, draft.providers[fallback].models[0] ?? "") : "");
  return draft;
}

export function managedEnvironment(draft: DeploymentDraft): Record<string, string> {
  const out: Record<string, string> = {
    SCOUT_PORT: String(draft.port),
    SCOUT_SECRET_KEY: draft.scoutSecret,
    SCOUT_WORKER_SECRET: draft.workerSecret,
    SCOUT_ADMIN_USERS: draft.adminUsers,
    SCOUT_WORKSPACE_ROOT: draft.workspaceRoot,
    SCOUT_BIND_ADDRESS: draft.bindAddress,
  };
  if (draft.dataDir) out.SCOUT_DATA_DIR = draft.dataDir;
  for (const id of draft.enabled) {
    const config = draft.providers[id];
    if (id === "vllm") {
      // Managed vLLM models get distinct provider entries and Docker services;
      // do not emit the generic VLLM_* catalog or it would shadow those routes.
      if (config.apiBase) {
        out.VLLM_MODEL = config.models[0] ?? "";
        out.VLLM_API_KEY = "local-vllm";
        out.VLLM_MODELS = config.models.map((model) => modelId("vllm", model)).join(",");
        out.VLLM_API_BASE = config.apiBase;
      }
    } else {
      out[`${id.toUpperCase()}_API_KEY`] = config.apiKey;
      out[`${id.toUpperCase()}_MODELS`] = config.models.join(",");
      if (config.apiBase) out[`${id.toUpperCase()}_API_BASE`] = config.apiBase;
    }
  }
  const fallback = draft.enabled[0];
  out.SCOUT_DEFAULT_MODEL = draft.defaultModel || (fallback ? modelId(fallback, draft.providers[fallback].models[0] ?? "") : "");
  return out;
}

export function mergeEnvironment(existing: string, managed: Record<string, string>, remove: string[] = []): string {
  const values = parseEnv(existing);
  for (const key of remove) values.delete(key);
  for (const [key, value] of Object.entries(managed)) values.set(key, value);
  const comments = existing.split(/\r?\n/).filter((line) => line.startsWith("#"));
  return ["# Managed by `scout deploy`. You may add other provider settings below.", ...comments, ...[...values.entries()].map(([key, value]) => `${key}=${value}`), ""].join("\n");
}

/** Draft with host paths resolved to absolute (compose bind mounts need them). */
function resolvedDraft(root: string, draft: DeploymentDraft): DeploymentDraft {
  return {
    ...draft,
    workspaceRoot: resolve(root, draft.workspaceRoot || "./workspace"),
    dataDir: draft.dataDir ? resolve(root, draft.dataDir) : "",
  };
}

function writeDeploymentEnvironment(root: string, draft: DeploymentDraft): void {
  const path = join(root, ".env"), current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const managed = managedEnvironment(resolvedDraft(root, draft));
  // Drop vars for providers/options that are no longer enabled.
  const stale = [...Object.values(PROVIDER_ENV_KEYS).flat(), "SCOUT_DATA_DIR", "SCOUT_BIND_ADDRESS"].filter((key) => !(key in managed));
  writeFileSync(path, mergeEnvironment(current, managed, stale), { mode: 0o600 });
}

export function writeSelectedConfiguration(root: string, draft: DeploymentDraft): void {
  const configPath = join(root, "config", "scout.yaml");
  const config = (yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>) ?? {};
  const providers: Record<string, Record<string, unknown>> = {};
  for (const id of draft.enabled) {
    const provider = draft.providers[id];
    if (id === "vllm" && !provider.apiBase) {
      provider.models.forEach((model, index) => {
        const slug = safeServiceName(model, index);
        providers[`vllm_${slug}`] = {
          api_key: "local-vllm",
          api_base: `http://vllm-${slug}:8000/v1`,
          models: [modelId("vllm", model)],
        };
      });
    } else {
      providers[id] = {
        ...(provider.apiBase ? { api_base: provider.apiBase } : {}),
        models: provider.models.map((model) => modelId(id, model)),
      };
    }
  }
  config.agent = {
    ...(config.agent ?? {}),
    model: draft.defaultModel,
    temperature: Number(draft.agent.temperature),
    max_iterations: draft.agent.maxIterations,
    provider_max_retries: draft.agent.providerMaxRetries,
    code_timeout: draft.agent.codeTimeout,
  };
  config.llm = { ...(config.llm ?? {}), providers };
  config.model_capabilities = { ...(config.model_capabilities ?? {}) };
  for (const [model, capability] of Object.entries(draft.visionCapabilities)) {
    config.model_capabilities[model] = { ...(config.model_capabilities[model] ?? {}), vision: capability };
  }
  config.server = {
    ...(config.server ?? {}),
    max_live_sessions: draft.server.maxLiveSessions,
    max_live_sessions_per_user: draft.server.maxLiveSessionsPerUser,
    max_concurrent_requests: draft.server.maxConcurrentRequests,
    max_queued_requests: draft.server.maxQueuedRequests,
    max_queued_requests_per_user: draft.server.maxQueuedRequestsPerUser,
    request_queue_timeout_seconds: draft.server.requestQueueTimeoutSeconds,
  };
  config.execution = {
    ...(config.execution ?? {}),
    enabled: draft.execution.enabled,
    network_default: draft.execution.networkDefault,
    timeout_seconds: draft.execution.timeoutSeconds,
    max_memory_mb: draft.execution.maxMemoryMb,
    max_processes: draft.execution.maxProcesses,
  };
  config.multi_agent = {
    ...(config.multi_agent ?? {}),
    enabled: draft.multiAgent.enabled,
    max_concurrent: draft.multiAgent.maxConcurrent,
    max_iterations: draft.multiAgent.maxIterations,
    default_background: draft.multiAgent.defaultBackground,
    auto_continue_on_complete: draft.multiAgent.autoContinueOnComplete,
  };
  writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: 120 }));

  const composePath = join(root, "docker-compose.yml");
  const start = "# scout-deploy:vllm:start", end = "# scout-deploy:vllm:end";
  let composeText = readFileSync(composePath, "utf8").replace(new RegExp(`\\n  ${start}[\\s\\S]*?  ${end}\\n`, "g"), "\n").replace("\n  vllm-cache:\n", "\n");
  if (draft.enabled.includes("vllm") && !draft.providers.vllm.apiBase) {
    const services = draft.providers.vllm.models.map((model, index) => vllmService(model, index, draft.vllmRuntime)).join("\n");
    composeText = composeText.replace("services:\n", `services:\n  ${start}\n${services}\n  ${end}\n`);
    composeText = composeText.replace("volumes:\n  scout-data:", "volumes:\n  scout-data:\n  vllm-cache:");
  }
  writeFileSync(composePath, composeText);

  const mcpPath = join(root, "config", "mcp.yaml");
  writeFileSync(mcpPath, `${JSON.stringify({ servers: draft.mcpServers }, null, 2)}\n`, { mode: 0o600 });
}

function safeServiceName(model: string, index: number): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38);
  return `${slug || "model"}-${index + 1}`;
}

function vllmService(model: string, index: number, runtime: VllmRuntimeConfig): string {
  const slug = safeServiceName(model, index);
  const args = [
    "--model", model,
    "--served-model-name", model,
    ...(runtime.gpuMemoryUtilization ? ["--gpu-memory-utilization", runtime.gpuMemoryUtilization] : []),
    ...(runtime.maxModelLen ? ["--max-model-len", runtime.maxModelLen] : []),
    ...(runtime.tensorParallelSize > 1 ? ["--tensor-parallel-size", String(runtime.tensorParallelSize)] : []),
    ...(runtime.quantization ? ["--quantization", runtime.quantization] : []),
    ...(runtime.toolCallParser ? ["--enable-auto-tool-choice", "--tool-call-parser", runtime.toolCallParser] : []),
    ...(runtime.reasoningParser ? ["--reasoning-parser", runtime.reasoningParser] : []),
  ];
  const gpuLine = runtime.gpuDevices === "all" ? "    gpus: all" : `    gpus: "device=${runtime.gpuDevices}"`;
  return `  vllm-${slug}:\n    image: ${runtime.image}\n    container_name: scout-vllm-${slug}\n    restart: unless-stopped\n${gpuLine}\n    ipc: host\n    volumes:\n      - vllm-cache:/root/.cache/huggingface\n    command: ${JSON.stringify(args)}\n    networks: [default]`;
}

function prepareWorkspace(root: string, draft: DeploymentDraft): void {
  const resolved = resolvedDraft(root, draft);
  const paths = [join(resolved.workspaceRoot, "users"), join(resolved.workspaceRoot, "shared"), ...(resolved.dataDir ? [resolved.dataDir] : [])];
  paths.forEach((path) => mkdirSync(path, { recursive: true }));
  if (!paths.some((path) => { const stat = statSync(path); return stat.uid !== 1000 || stat.gid !== 1000; })) return;
  console.log(`${C.yellow}Scout containers run as UID 1000. Updating mounted workspace ownership…${C.reset}`);
  if (spawnSync("sudo", ["chown", "-R", "1000:1000", ...paths], { stdio: "inherit" }).status !== 0) throw new Error("Workspace ownership was not updated. Your draft is saved; run scout deploy --resume after sudo succeeds.");
}

function compose(root: string, args: string[]): void {
  const command = composeCommand();
  if (!command) throw new Error("Docker Compose is unavailable.");
  const [binary, prefix] = command;
  const building = args[0] === "build" || args.includes("--build");
  const env = building && !supportsBuildx()
    ? { ...process.env, DOCKER_BUILDKIT: "0", COMPOSE_DOCKER_CLI_BUILD: "0" }
    : process.env;
  if (building && !supportsBuildx()) console.log(`${C.yellow}Buildx < 0.17 detected; using Docker's classic builder for compatibility.${C.reset}`);
  if (spawnSync(binary, [...prefix, ...args], { cwd: root, stdio: "inherit", env }).status !== 0) throw new Error(`${binary} ${args.join(" ")} failed.`);
}

export function runDeploymentAction(root: string, action: DeployAction, noCache = false): void {
  requireDocker(root);
  if (action === "status") return compose(root, ["ps"]);
  if (action === "logs") return compose(root, ["logs", "--tail", "150"]);
  if (action === "restart") return compose(root, ["restart"]);
  if (action === "rebuild") { if (noCache) compose(root, ["build", "--no-cache"]); return compose(root, ["up", "--build", "--detach", "--force-recreate"]); }
  compose(root, ["up", "--build", "--detach"]);
}

export async function runDeploymentWizard(root: string, initialAction: DeployAction = "setup", resume = false, noCache = false): Promise<void> {
  requireDocker(root);
  if (initialAction !== "setup") return runDeploymentAction(root, initialAction, noCache);
  if (!input.isTTY || !output.isTTY) throw new Error("scout deploy is interactive and needs a terminal. Use --status/--logs/--restart/--rebuild for non-interactive actions.");

  const { render } = await import("ink");
  const React = await import("react");
  const { DeployApp } = await import("./tui/DeployApp.js");
  type WizardOutcome = "apply" | "save" | "quit";

  // Prefer an in-progress draft; otherwise seed from the live .env so the
  // wizard edits the current deployment instead of starting from defaults.
  const saved = loadDraft(root);
  const hasEnv = existsSync(join(root, ".env"));
  const useSaved = saved && (resume || saved.phase !== "complete");
  const draft = useSaved ? saved : draftFromEnvironment(root);
  const source: "draft" | "env" | "fresh" = useSaved ? "draft" : hasEnv ? "env" : "fresh";
  const checks = preflight();

  // Run the wizard in the alternate screen buffer so quitting restores
  // the user's terminal untouched.
  output.write("\x1b[?1049h\x1b[H");
  let outcome: WizardOutcome = "quit";
  let finalDraft = draft;
  try {
    const { waitUntilExit } = render(
      React.createElement(DeployApp, {
        draft,
        source,
        checks,
        draftPath: `${DRAFT_DIR}/draft.json`,
        freshDraft: newDeploymentDraft,
        onPersist: (next) => saveDraft(root, next),
        onDone: (result, next) => { outcome = result; finalDraft = next; },
      }),
      { exitOnCtrlC: true },
    );
    await waitUntilExit();
  } finally {
    output.write("\x1b[?1049l");
  }

  if (outcome === "quit") return;
  if (outcome === "save") { saveDraft(root, finalDraft); console.log(`${C.yellow}Draft saved.${C.reset} Resume with: ${C.bold}scout deploy --resume${C.reset}`); return; }

  // Apply: back in the normal buffer so docker compose output streams as usual.
  console.log(`${C.cyan}${C.bold}✦ Scout Deploy${C.reset} ${C.dim}· applying ${finalDraft.enabled.join(" + ")} · default ${finalDraft.defaultModel} · port ${finalDraft.port}${C.reset}\n`);
  prepareWorkspace(root, finalDraft); writeDeploymentEnvironment(root, finalDraft); writeSelectedConfiguration(root, finalDraft);
  runDeploymentAction(root, noCache ? "rebuild" : "launch", noCache);
  finalDraft.phase = "complete"; saveDraft(root, finalDraft);
  console.log(`\n${C.green}${C.bold}Scout is launching.${C.reset} Open ${C.bold}http://localhost:${finalDraft.port}${C.reset}`);
  console.log(`${C.dim}Later: scout deploy --status, --logs, --restart, or --rebuild --no-cache${C.reset}`);
}
