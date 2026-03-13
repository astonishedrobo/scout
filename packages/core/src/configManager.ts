/**
 * Config management for Scout CLI.
 *
 * Handles reading/writing config from:
 * - Global: ~/.config/scout/config.yaml
 * - Project: <cwd>/.scout/config.yaml
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import type { ScoutConfig, LLMProviderConfig } from "./types.js";

const GLOBAL_DIR = join(homedir(), ".config", "scout");
const GLOBAL_CONFIG = join(GLOBAL_DIR, "config.yaml");

export function globalConfigPath(): string {
  return GLOBAL_CONFIG;
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".scout", "config.yaml");
}

export function globalConfigExists(): boolean {
  return existsSync(GLOBAL_CONFIG);
}

export function projectConfigExists(cwd?: string): boolean {
  return existsSync(projectConfigPath(cwd));
}

/** Read and parse a YAML config file. Returns {} if missing. */
function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  return (yaml.load(content) as Record<string, unknown>) ?? {};
}

/** Deep-merge override into base (override wins). */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (
      key in merged &&
      typeof merged[key] === "object" &&
      merged[key] !== null &&
      !Array.isArray(merged[key]) &&
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val)
    ) {
      merged[key] = deepMerge(
        merged[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

/** Get the merged config (global + project). */
export function getMergedConfig(cwd?: string): ScoutConfig {
  const global = readYaml(GLOBAL_CONFIG);
  const project = readYaml(projectConfigPath(cwd));
  return deepMerge(global, project) as ScoutConfig;
}

/**
 * Set a dotted config key in the specified scope.
 * Example: setConfigValue("agent.model", "gpt-4o", "project")
 */
export function setConfigValue(
  key: string,
  value: unknown,
  scope: "global" | "project" = "project",
  cwd?: string
): void {
  const path = scope === "global" ? GLOBAL_CONFIG : projectConfigPath(cwd);
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const raw = readYaml(path);
  const keys = key.split(".");
  let obj = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (!(k in obj) || typeof obj[k] !== "object" || obj[k] === null) {
      obj[k] = {};
    }
    obj = obj[k] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]!] = value;

  writeFileSync(path, yaml.dump(raw, { flowLevel: -1 }), "utf-8");
}

/** Get a dotted config value from the merged config. */
export function getConfigValue(key: string, cwd?: string): unknown {
  const config = getMergedConfig(cwd) as Record<string, unknown>;
  const keys = key.split(".");
  let obj: unknown = config;
  for (const k of keys) {
    if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
    obj = (obj as Record<string, unknown>)[k];
  }
  return obj;
}

/**
 * Write a minimal global config (used by the first-run wizard).
 */
export function writeGlobalConfig(config: Record<string, unknown>): void {
  if (!existsSync(GLOBAL_DIR)) mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(GLOBAL_CONFIG, yaml.dump(config, { flowLevel: -1 }), "utf-8");
}

/**
 * Create a project config template at .scout/config.yaml
 */
export function initProjectConfig(cwd: string = process.cwd()): string {
  const dir = join(cwd, ".scout");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.yaml");

  const template: Record<string, unknown> = {
    data_paths: {
      // Example: uncomment and edit
      // csv_dir: "./data/csv_files"
      // text_dir: "./data/text_files"
      // json_dir: "./data/json_files"
      // pdf_dir: "./data/pdf_files"
    },
    retriever: {
      top_k: 5,
      chunk_size: 800,
      chunk_overlap: 100,
    },
    json_sources: {},
    csv_sources: {},
  };

  writeFileSync(path, yaml.dump(template, { flowLevel: -1 }), "utf-8");
  return path;
}

// ── LLM config helpers ──────────────────────────────────────────

/** Aggregate all models from llm.providers that have an api_key. */
export function getConfiguredModels(cwd?: string): string[] {
  const config = getMergedConfig(cwd);
  const providers = config.llm?.providers;
  if (!providers) return [];
  const models: string[] = [];
  for (const prov of Object.values(providers)) {
    const p = prov as LLMProviderConfig;
    if (p.api_key && Array.isArray(p.models)) {
      models.push(...p.models);
    }
  }
  return models;
}

/** True if at least one provider has an api_key and at least one model. */
export function hasLLMConfigured(cwd?: string): boolean {
  return getConfiguredModels(cwd).length > 0;
}

/** Extract env vars (API keys / bases) from llm.providers for injection. */
export function getLLMEnvVars(cwd?: string): Record<string, string> {
  const config = getMergedConfig(cwd);
  const providers = config.llm?.providers;
  if (!providers) return {};
  const env: Record<string, string> = {};
  for (const [name, prov] of Object.entries(providers)) {
    const p = prov as LLMProviderConfig;
    if (p.api_key) {
      env[`${name.toUpperCase()}_API_KEY`] = p.api_key;
    }
    if (p.api_base) {
      env[`${name.toUpperCase()}_API_BASE`] = p.api_base;
    }
  }
  return env;
}

/** YAML template prepopulated when no llm section exists yet. */
export function getLLMConfigTemplate(): string {
  return `# LLM Provider Configuration
# Add your API keys and models below.
# Model names use litellm format: provider/model-name
# Docs: https://docs.litellm.ai/docs/providers

llm:
  providers:
    # groq:
    #   api_key: gsk_your_key_here
    #   models:
    #     - groq/llama-3.1-8b-instant
    #     - groq/llama-3.3-70b-versatile
    # openai:
    #   api_key: sk-your_key_here
    #   models:
    #     - openai/gpt-4o
    #     - openai/gpt-4o-mini
    # anthropic:
    #   api_key: sk-ant-your_key_here
    #   models:
    #     - anthropic/claude-sonnet-4-20250514
`;
}

/** Ensure the global config file has the llm section. Prepopulates template if missing. */
export function ensureLLMSection(): void {
  const raw = readYaml(GLOBAL_CONFIG);
  if (raw.llm) return;

  if (!existsSync(GLOBAL_DIR)) mkdirSync(GLOBAL_DIR, { recursive: true });
  const existing = existsSync(GLOBAL_CONFIG) ? readFileSync(GLOBAL_CONFIG, "utf-8") : "";
  const template = getLLMConfigTemplate();
  const combined = existing.trim()
    ? `${existing.trimEnd()}\n\n${template}`
    : template;
  writeFileSync(GLOBAL_CONFIG, combined, "utf-8");
}
