/** Resumable, interactive Docker deployment wizard. */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { join, resolve } from "node:path";

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m" };
const DRAFT_DIR = ".scout/deployment";

export type DeployAction = "setup" | "launch" | "restart" | "rebuild" | "status" | "logs";

export type ProviderId = "openai" | "groq" | "anthropic" | "vllm";
export const PROVIDER_IDS: ProviderId[] = ["openai", "groq", "anthropic", "vllm"];

export interface ProviderConfig {
  model: string;
  /** Unused for vllm. */
  apiKey: string;
}

export interface DeploymentDraft {
  version: 2;
  phase: "providers" | "models" | "access" | "review" | "complete";
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
  scoutSecret: string;
  workerSecret: string;
  updatedAt: string;
}

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

export function deploymentDraftPath(root: string): string { return join(root, DRAFT_DIR, "draft.json"); }

export function newDeploymentDraft(): DeploymentDraft {
  return {
    version: 2,
    phase: "providers",
    enabled: [],
    providers: {
      openai: { model: "openai/gpt-5-mini", apiKey: "" },
      groq: { model: "groq/llama-3.1-8b-instant", apiKey: "" },
      anthropic: { model: "", apiKey: "" },
      vllm: { model: "Qwen/Qwen3-0.6B", apiKey: "" },
    },
    defaultModel: "",
    port: 4200,
    adminUsers: "",
    workspaceRoot: "./workspace",
    dataDir: "",
    scoutSecret: randomBytes(32).toString("hex"),
    workerSecret: randomBytes(32).toString("hex"),
    updatedAt: new Date().toISOString(),
  };
}

function migrateDraft(v1: DeploymentDraftV1): DeploymentDraft {
  const draft = newDeploymentDraft();
  draft.enabled = [v1.provider];
  draft.providers[v1.provider] = {
    model: v1.model,
    apiKey: v1.provider === "openai" ? v1.openaiApiKey : v1.provider === "groq" ? v1.groqApiKey : v1.provider === "anthropic" ? v1.anthropicApiKey : "",
  };
  draft.defaultModel = modelId(v1.provider, v1.model);
  draft.port = v1.port;
  draft.adminUsers = v1.adminUsers;
  draft.scoutSecret = v1.scoutSecret;
  draft.workerSecret = v1.workerSecret;
  return draft;
}

function saveDraft(root: string, draft: DeploymentDraft): void {
  const path = deploymentDraftPath(root);
  mkdirSync(resolve(path, ".."), { recursive: true });
  draft.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
}

function loadDraft(root: string): DeploymentDraft | undefined {
  const path = deploymentDraftPath(root);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as DeploymentDraft | DeploymentDraftV1;
    if (value.version === 2) return { ...newDeploymentDraft(), ...value };
    if (value.version === 1) return migrateDraft(value);
    return undefined;
  } catch { return undefined; }
}

function check(command: string, args: string[]): boolean { return spawnSync(command, args, { stdio: "ignore" }).status === 0; }

function hasNvidiaRuntime(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{json .Runtimes.nvidia}}"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "" && result.stdout.trim() !== "null";
}

function preflight(): { docker: boolean; compose: boolean; gpu: boolean; nvidiaRuntime: boolean } {
  return { docker: check("docker", ["version"]), compose: check("docker", ["compose", "version"]), gpu: check("nvidia-smi", ["-L"]), nvidiaRuntime: hasNvidiaRuntime() };
}

function requireDocker(root: string): void {
  if (!check("docker", ["version"]) || !check("docker", ["compose", "version"])) throw new Error("Docker Engine and Docker Compose are required. Install them, then run scout deploy --resume.");
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
  openai: ["OPENAI_API_KEY", "OPENAI_MODELS"],
  groq: ["GROQ_API_KEY", "GROQ_MODELS"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODELS"],
  vllm: ["VLLM_MODEL", "VLLM_API_KEY", "VLLM_MODELS"],
};

export function draftFromEnvironment(root: string, env?: Map<string, string>): DeploymentDraft {
  const draft = newDeploymentDraft();
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

  const firstModel = (raw: string) => raw.split(",")[0]!.trim();
  for (const id of ["openai", "groq", "anthropic"] as const) {
    const key = get(`${id.toUpperCase()}_API_KEY`);
    if (!key) continue;
    draft.enabled.push(id);
    draft.providers[id].apiKey = key;
    const models = get(`${id.toUpperCase()}_MODELS`);
    if (models) draft.providers[id].model = firstModel(models);
  }
  if (get("VLLM_MODEL")) {
    draft.enabled.push("vllm");
    draft.providers.vllm.model = get("VLLM_MODEL");
  }

  const fallback = draft.enabled[0];
  draft.defaultModel = get("SCOUT_DEFAULT_MODEL") || (fallback ? modelId(fallback, draft.providers[fallback].model) : "");
  return draft;
}

export function managedEnvironment(draft: DeploymentDraft): Record<string, string> {
  const out: Record<string, string> = {
    SCOUT_PORT: String(draft.port),
    SCOUT_SECRET_KEY: draft.scoutSecret,
    SCOUT_WORKER_SECRET: draft.workerSecret,
    SCOUT_ADMIN_USERS: draft.adminUsers,
    SCOUT_WORKSPACE_ROOT: draft.workspaceRoot,
  };
  if (draft.dataDir) out.SCOUT_DATA_DIR = draft.dataDir;
  for (const id of draft.enabled) {
    const config = draft.providers[id];
    if (id === "vllm") {
      out.VLLM_MODEL = config.model;
      out.VLLM_API_KEY = "local-vllm";
      out.VLLM_MODELS = modelId("vllm", config.model);
    } else {
      out[`${id.toUpperCase()}_API_KEY`] = config.apiKey;
      out[`${id.toUpperCase()}_MODELS`] = config.model;
    }
  }
  const fallback = draft.enabled[0];
  out.SCOUT_DEFAULT_MODEL = draft.defaultModel || (fallback ? modelId(fallback, draft.providers[fallback].model) : "");
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
  const stale = [...Object.values(PROVIDER_ENV_KEYS).flat(), "SCOUT_DATA_DIR"].filter((key) => !(key in managed));
  writeFileSync(path, mergeEnvironment(current, managed, stale), { mode: 0o600 });
}

function writeSelectedConfiguration(root: string, draft: DeploymentDraft): void {
  const configPath = join(root, "config", "scout.yaml");
  const base = readFileSync(configPath, "utf8").replace(/^agent:\n  model: .*$/m, `agent:\n  model: ${draft.defaultModel}`).replace(/\nllm:\n  providers:[\s\S]*$/, "");
  const providersYaml = draft.enabled
    .map((id) => `    ${id}:\n      models:\n        - ${modelId(id, draft.providers[id].model)}`)
    .join("\n");
  const capabilities = draft.enabled.includes("vllm")
    ? `\nmodel_capabilities:\n  ${modelId("vllm", draft.providers.vllm.model)}:\n    vision: unsupported\n`
    : "";
  writeFileSync(configPath, `${base}\nllm:\n  providers:\n${providersYaml}\n${capabilities}`);

  const composePath = join(root, "docker-compose.yml");
  const start = "# scout-deploy:vllm:start", end = "# scout-deploy:vllm:end";
  let composeText = readFileSync(composePath, "utf8").replace(new RegExp(`\\n  ${start}[\\s\\S]*?  ${end}\\n`, "g"), "\n").replace("\n  vllm-cache:\n", "\n");
  if (draft.enabled.includes("vllm")) {
    const service = `  ${start}\n  vllm:\n    image: vllm/vllm-openai:latest\n    container_name: scout-vllm\n    restart: unless-stopped\n    gpus: all\n    ipc: host\n    volumes:\n      - vllm-cache:/root/.cache/huggingface\n    command: [--model, \${VLLM_MODEL}, --served-model-name, \${VLLM_MODEL}, --enable-auto-tool-choice, --tool-call-parser, hermes, --reasoning-parser, qwen3]\n    networks: [default]\n  ${end}\n`;
    composeText = composeText.replace("services:\n", `services:\n${service}`);
    composeText = composeText.replace("volumes:\n  scout-data:", "volumes:\n  scout-data:\n  vllm-cache:");
  }
  writeFileSync(composePath, composeText);
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
  if (spawnSync("docker", ["compose", ...args], { cwd: root, stdio: "inherit" }).status !== 0) throw new Error(`docker compose ${args.join(" ")} failed.`);
}

export function runDeploymentAction(root: string, action: DeployAction, noCache = false): void {
  requireDocker(root);
  if (action === "status") return compose(root, ["ps"]);
  if (action === "logs") return compose(root, ["logs", "--tail", "150", "scout-server", "execution-worker", "vllm"]);
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
