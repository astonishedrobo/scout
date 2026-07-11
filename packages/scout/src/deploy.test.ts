import assert from "node:assert/strict";
import test from "node:test";
import { draftFromEnvironment, managedEnvironment, mergeEnvironment, newDeploymentDraft } from "./deploy.js";

test("deployment environment exposes every enabled provider", () => {
  const draft = newDeploymentDraft();
  draft.enabled = ["groq", "vllm"];
  draft.providers.groq = { model: "groq/llama-3.1-8b-instant", apiKey: "gsk-test" };
  draft.providers.vllm.model = "Qwen/Qwen3-1.7B";
  draft.defaultModel = "hosted_vllm/Qwen/Qwen3-1.7B";
  draft.port = 4310;

  assert.deepEqual(managedEnvironment(draft), {
    SCOUT_PORT: "4310",
    GROQ_API_KEY: "gsk-test",
    GROQ_MODELS: "groq/llama-3.1-8b-instant",
    VLLM_MODEL: "Qwen/Qwen3-1.7B",
    VLLM_API_KEY: "local-vllm",
    VLLM_MODELS: "hosted_vllm/Qwen/Qwen3-1.7B",
    SCOUT_DEFAULT_MODEL: "hosted_vllm/Qwen/Qwen3-1.7B",
    SCOUT_SECRET_KEY: draft.scoutSecret,
    SCOUT_WORKER_SECRET: draft.workerSecret,
    SCOUT_ADMIN_USERS: "",
    SCOUT_WORKSPACE_ROOT: "./workspace",
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
  assert.equal(draft.providers.groq.model, "groq/llama-3.3-70b-versatile");
  assert.equal(draft.providers.groq.apiKey, "gsk-existing");
  assert.equal(draft.providers.openai.apiKey, "sk-existing");
  assert.equal(draft.defaultModel, "groq/llama-3.3-70b-versatile");
  assert.equal(draft.port, 4321);
  assert.equal(draft.adminUsers, "alice,bob");
  assert.equal(draft.scoutSecret, "keep-secret");
  assert.equal(draft.workerSecret, "keep-worker");
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
