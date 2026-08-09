import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { draftFromEnvironment, managedEnvironment, mergeEnvironment, newDeploymentDraft, writeSelectedConfiguration } from "./deploy.js";

test("deployment environment exposes every enabled provider", () => {
  const draft = newDeploymentDraft();
  draft.enabled = ["groq", "vllm"];
  draft.providers.groq = { models: ["groq/llama-3.1-8b-instant"], apiKey: "gsk-test", apiBase: "" };
  draft.providers.vllm.models = ["Qwen/Qwen3-1.7B"];
  draft.defaultModel = "hosted_vllm/Qwen/Qwen3-1.7B";
  draft.port = 4310;

  assert.deepEqual(managedEnvironment(draft), {
    SCOUT_PORT: "4310",
    GROQ_API_KEY: "gsk-test",
    GROQ_MODELS: "groq/llama-3.1-8b-instant",
    SCOUT_DEFAULT_MODEL: "hosted_vllm/Qwen/Qwen3-1.7B",
    SCOUT_SECRET_KEY: draft.scoutSecret,
    SCOUT_WORKER_SECRET: draft.workerSecret,
    SCOUT_ADMIN_USERS: "",
    SCOUT_WORKSPACE_ROOT: "./workspace",
    SCOUT_BIND_ADDRESS: "0.0.0.0",
  });
});

test("custom workspace and data locations round-trip through the environment", () => {
  const draft = newDeploymentDraft();
  draft.enabled = ["openai"];
  draft.providers.openai.apiKey = "sk-x";
  draft.workspaceRoot = "/srv/scout/workspace";
  draft.dataDir = "/srv/scout/data";

  const env = managedEnvironment(draft);
  assert.equal(env.SCOUT_WORKSPACE_ROOT, "/srv/scout/workspace");
  assert.equal(env.SCOUT_DATA_DIR, "/srv/scout/data");

  const seeded = draftFromEnvironment("/nonexistent", new Map(Object.entries(env)));
  assert.equal(seeded.workspaceRoot, "/srv/scout/workspace");
  assert.equal(seeded.dataDir, "/srv/scout/data");
});

test("multiple models and provider endpoints round-trip through the environment", () => {
  const draft = newDeploymentDraft();
  draft.enabled = ["openai", "vllm"];
  draft.providers.openai.models = ["openai/gpt-5-mini", "openai/gpt-4.1-mini"];
  draft.providers.openai.apiKey = "sk-x";
  draft.providers.openai.apiBase = "https://gateway.example/v1";
  draft.providers.vllm.models = ["Qwen/Qwen3-0.6B", "Qwen/Qwen3-1.7B"];
  draft.providers.vllm.apiBase = "https://vllm.example/v1";

  const env = managedEnvironment(draft);
  assert.equal(env.OPENAI_MODELS, "openai/gpt-5-mini,openai/gpt-4.1-mini");
  assert.equal(env.OPENAI_API_BASE, "https://gateway.example/v1");
  assert.equal(env.VLLM_MODELS, "hosted_vllm/Qwen/Qwen3-0.6B,hosted_vllm/Qwen/Qwen3-1.7B");
  assert.equal(env.VLLM_API_BASE, "https://vllm.example/v1");

  const seeded = draftFromEnvironment("/nonexistent", new Map(Object.entries(env)));
  assert.deepEqual(seeded.providers.openai.models, draft.providers.openai.models);
  assert.deepEqual(seeded.providers.vllm.models, draft.providers.vllm.models);
  assert.equal(seeded.providers.openai.apiBase, draft.providers.openai.apiBase);
});

test("wizard draft is seeded with every provider in the environment", () => {
  const env = new Map(Object.entries({
    SCOUT_PORT: "4321",
    SCOUT_ADMIN_USERS: "alice,bob",
    SCOUT_SECRET_KEY: "keep-secret",
    SCOUT_WORKER_SECRET: "keep-worker",
    GROQ_API_KEY: "gsk-existing",
    GROQ_MODELS: "groq/llama-3.3-70b-versatile",
    OPENAI_API_KEY: "sk-existing",
    OPENAI_MODELS: "openai/gpt-5-mini",
    SCOUT_DEFAULT_MODEL: "groq/llama-3.3-70b-versatile",
  }));

  const draft = draftFromEnvironment("/nonexistent", env);
  assert.deepEqual(draft.enabled, ["openai", "groq"]);
  assert.deepEqual(draft.providers.groq.models, ["groq/llama-3.3-70b-versatile"]);
  assert.equal(draft.providers.groq.apiKey, "gsk-existing");
  assert.equal(draft.providers.openai.apiKey, "sk-existing");
  assert.equal(draft.defaultModel, "groq/llama-3.3-70b-versatile");
  assert.equal(draft.port, 4321);
  assert.equal(draft.adminUsers, "alice,bob");
  assert.equal(draft.scoutSecret, "keep-secret");
  assert.equal(draft.workerSecret, "keep-worker");
});

test("a provider key without a model catalog does not become an incomplete enabled provider", () => {
  const draft = draftFromEnvironment("/nonexistent", new Map(Object.entries({
    ANTHROPIC_API_KEY: "sk-ant-existing",
  })));
  assert.deepEqual(draft.enabled, []);
  assert.equal(draft.providers.anthropic.apiKey, "sk-ant-existing");
  assert.deepEqual(draft.providers.anthropic.models, []);
});

test("environment merge preserves unrelated settings and drops removed ones", () => {
  const merged = mergeEnvironment(
    "# existing\nLANGSMITH_TRACING=true\nOPENAI_API_KEY=old\nVLLM_MODEL=stale\n",
    { SCOUT_PORT: "4300", OPENAI_API_KEY: "new" },
    ["VLLM_MODEL"],
  );

  assert.match(merged, /LANGSMITH_TRACING=true/);
  assert.match(merged, /OPENAI_API_KEY=new/);
  assert.match(merged, /SCOUT_PORT=4300/);
  assert.doesNotMatch(merged, /VLLM_MODEL/);
});

test("deployment draft loads the existing MCP bootstrap", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-deploy-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "mcp.yaml"), JSON.stringify({
    servers: [{
      id: "linear", name: "Linear", transport: "streamable_http",
      url: "https://example.test/mcp", availability: "everyone",
      enabled: true, auth_mode: "none",
    }],
  }));

  const draft = draftFromEnvironment(root, new Map());
  assert.equal(draft.version, 4);
  assert.equal(draft.mcpServers.length, 1);
  assert.equal(draft.mcpServers[0]?.id, "linear");
});

test("deployment draft accepts manually-authored YAML MCP configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-deploy-mcp-yaml-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "mcp.yaml"), [
    "servers:",
    "  - id: brave",
    "    name: Brave Search",
    "    transport: streamable_http",
    "    url: https://example.test/mcp",
    "    availability: everyone",
    "    enabled: true",
    "    auth_mode: bearer",
    "    credential_env: BRAVE_API_KEY",
    "",
  ].join("\n"));

  const draft = draftFromEnvironment(root, new Map([["BRAVE_API_KEY", "brave-secret"]]));
  assert.equal(draft.mcpServers[0]?.id, "brave");
  assert.equal(draft.mcpCredentials.brave, "brave-secret");
});

test("deployment MCP credentials round-trip through .env without entering mcp.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-deploy-mcp-credential-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "scout.yaml"), "llm:\n  providers: {}\n");
  writeFileSync(join(root, "docker-compose.yml"), "services:\n  scout-server:\nvolumes:\n  scout-data:\n");
  writeFileSync(join(root, "config", "mcp.yaml"), "{\"servers\":[]}");

  const draft = newDeploymentDraft();
  draft.mcpServers = [{
    id: "exa", name: "Exa Search", transport: "streamable_http",
    url: "https://mcp.exa.ai/mcp?tools=web_search_exa",
    availability: "everyone", enabled: true, auth_mode: "bearer",
    credential_env: "EXA_API_KEY",
  }];
  draft.mcpCredentials.exa = "exa-test-secret";

  assert.equal(managedEnvironment(draft).EXA_API_KEY, "exa-test-secret");
  writeSelectedConfiguration(root, draft);

  const mcpText = readFileSync(join(root, "config", "mcp.yaml"), "utf8");
  assert.match(mcpText, /"credential_env": "EXA_API_KEY"/);
  assert.doesNotMatch(mcpText, /exa-test-secret/);

  const seeded = draftFromEnvironment(root, new Map([["EXA_API_KEY", "rotated-secret"]]));
  assert.equal(seeded.mcpCredentials.exa, "rotated-secret");
  assert.equal(seeded.mcpServers[0]?.credential_env, "EXA_API_KEY");
});

test("configuration output preserves custom settings and creates one managed vLLM service per model", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-deploy-config-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "scout.yaml"), [
    "custom_feature:",
    "  enabled: true",
    "agent:",
    "  model: old/model",
    "llm:",
    "  providers: {}",
    "model_capabilities:",
    "  old/model:",
    "    vision: supported",
    "",
  ].join("\n"));
  writeFileSync(join(root, "docker-compose.yml"), "services:\n  scout-server:\nvolumes:\n  scout-data:\n");
  writeFileSync(join(root, "config", "mcp.yaml"), "{\"servers\":[]}");

  const draft = newDeploymentDraft();
  draft.enabled = ["vllm"];
  draft.providers.vllm.models = ["Qwen/Qwen3-0.6B", "Qwen/Qwen3-1.7B"];
  draft.defaultModel = "hosted_vllm/Qwen/Qwen3-1.7B";
  draft.visionCapabilities = { "hosted_vllm/Qwen/Qwen3-1.7B": "supported" };
  writeSelectedConfiguration(root, draft);

  const config = yaml.load(readFileSync(join(root, "config", "scout.yaml"), "utf8")) as Record<string, any>;
  assert.equal(config.custom_feature.enabled, true);
  assert.deepEqual(Object.keys(config.llm.providers), ["vllm_qwen-qwen3-0-6b-1", "vllm_qwen-qwen3-1-7b-2"]);
  assert.equal(config.agent.model, "hosted_vllm/Qwen/Qwen3-1.7B");
  assert.equal(config.model_capabilities["old/model"].vision, "supported");
  assert.equal(config.model_capabilities["hosted_vllm/Qwen/Qwen3-1.7B"].vision, "supported");
  const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /vllm-qwen-qwen3-0-6b-1:/);
  assert.match(compose, /vllm-qwen-qwen3-1-7b-2:/);
  const recovered = draftFromEnvironment(root, new Map());
  assert.deepEqual(recovered.providers.vllm.models, draft.providers.vllm.models);
  assert.equal(recovered.defaultModel, draft.defaultModel);
});
