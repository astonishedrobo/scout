/**
 * Scout deploy wizard — single-screen Ink app.
 *
 * Steps: Providers → Settings → Integrations → Review. Each provider on
 * the first step is a menu — Enter opens it to nested Model / API key
 * chips, space toggles it on/off. Navigation is never forced through
 * one path: ↑ from the top of any screen focuses the step bar (←/→ to
 * pick a step, Enter to open it), and ctrl+n / ctrl+p step forward and
 * back from anywhere, text fields included. Esc walks back, `r` starts
 * over. Pure UI: persistence and docker orchestration stay in deploy.ts.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { theme } from "scout-core/theme";
import { modelId, PROVIDER_IDS, type DeploymentDraft, type McpBootstrapServer, type ProviderId } from "../deploy.js";
import { CardRow, Field, KeyHints, SelectList, StepTrail, ToggleRow, useTerminalSize, type KeyHint } from "./widgets.js";

export type WizardOutcome = "apply" | "save" | "quit";

export interface PreflightChecks {
  docker: boolean;
  compose: boolean;
  gpu: boolean;
  nvidiaRuntime: boolean;
}

interface DeployAppProps {
  draft: DeploymentDraft;
  /** Where the initial draft came from, shown in the header. */
  source: "draft" | "env" | "fresh";
  checks: PreflightChecks;
  draftPath: string;
  /** Factory for a from-scratch draft (used by the `r` start-over key). */
  freshDraft: () => DeploymentDraft;
  onPersist: (draft: DeploymentDraft) => void;
  onDone: (outcome: WizardOutcome, draft: DeploymentDraft) => void;
}

const STEPS = ["Providers", "Settings", "Integrations", "Review"];
const SETTINGS_FIELDS = 5;

interface ProviderMeta {
  id: ProviderId;
  label: string;
  tag?: string;
  blurb: string;
  keyLabel?: string;
  models: { label: string; value?: string; detail?: string }[];
  /** Example shown as the custom-model placeholder. */
  example: string;
  /** How the model ID is completed for this provider. */
  idHint: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "openai",
    label: "OpenAI",
    blurb: "Hosted API · needs an OpenAI API key",
    keyLabel: "OpenAI API key",
    models: [
      { label: "openai/gpt-5-mini", value: "openai/gpt-5-mini" },
      { label: "Custom model ID…" },
    ],
    example: "gpt-5-mini",
    idHint: "The openai/ prefix is added automatically — type gpt-5-mini or openai/gpt-5-mini.",
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Fast open-model inference · needs a Groq API key",
    keyLabel: "Groq API key",
    models: [
      { label: "groq/llama-3.1-8b-instant", value: "groq/llama-3.1-8b-instant", detail: "fastest" },
      { label: "groq/llama-3.3-70b-versatile", value: "groq/llama-3.3-70b-versatile", detail: "better quality" },
      { label: "Custom model ID…" },
    ],
    example: "llama-3.3-70b-versatile",
    idHint: "The groq/ prefix is added automatically — type the model name as Groq lists it.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Hosted API · needs an Anthropic API key",
    keyLabel: "Anthropic API key",
    models: [{ label: "Enter a model ID…" }],
    example: "model-name",
    idHint: "The anthropic/ prefix is added automatically — type the model name as Anthropic lists it.",
  },
  {
    id: "vllm",
    label: "Local vLLM",
    tag: "GPU",
    blurb: "Self-hosted on your NVIDIA GPU · no API key needed",
    models: [
      { label: "Qwen/Qwen3-0.6B", value: "Qwen/Qwen3-0.6B", detail: "quickest to start" },
      { label: "Qwen/Qwen3-1.7B", value: "Qwen/Qwen3-1.7B", detail: "better quality" },
      { label: "Custom Hugging Face model ID…" },
    ],
    example: "Qwen/Qwen3-1.7B",
    idHint: "Type the Hugging Face repo ID (org/model). Scout serves it as hosted_vllm/<id> automatically.",
  },
];

const META: Record<ProviderId, ProviderMeta> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p])) as Record<ProviderId, ProviderMeta>;

const SOURCE_NOTE: Record<DeployAppProps["source"], string> = {
  draft: "resumed from saved draft",
  env: "loaded from current .env",
  fresh: "new configuration",
};

/**
 * Screen ids. Top-level: providers, default, access, review.
 * Nested under providers: menu:<id>, model:<id>, key:<id>.
 */
type Screen = string;

export const DeployApp: React.FC<DeployAppProps> = ({
  draft: initialDraft,
  source: initialSource,
  checks,
  draftPath,
  freshDraft,
  onPersist,
  onDone,
}) => {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [draft, setDraft] = useState<DeploymentDraft>(initialDraft);
  const [source, setSource] = useState(initialSource);
  const [screen, setScreen] = useState<Screen>("providers");
  const [customModel, setCustomModel] = useState(false);
  const [modelText, setModelText] = useState("");
  const [defaultModelText, setDefaultModelText] = useState("");
  const [modelFocus, setModelFocus] = useState(0);
  const [keyText, setKeyText] = useState("");
  const [endpointText, setEndpointText] = useState("");
  const [adminText, setAdminText] = useState(initialDraft.adminUsers);
  const [portText, setPortText] = useState(String(initialDraft.port));
  const [workspaceText, setWorkspaceText] = useState(initialDraft.workspaceRoot);
  const [dataText, setDataText] = useState(initialDraft.dataDir);
  const [bindText, setBindText] = useState(initialDraft.bindAddress);
  const [visionSupportedText, setVisionSupportedText] = useState("");
  const [visionUnsupportedText, setVisionUnsupportedText] = useState("");
  const [agentText, setAgentText] = useState(`${initialDraft.agent.temperature},${initialDraft.agent.maxIterations},${initialDraft.agent.providerMaxRetries},${initialDraft.agent.codeTimeout}`);
  const [serverText, setServerText] = useState(`${initialDraft.server.maxLiveSessions},${initialDraft.server.maxLiveSessionsPerUser},${initialDraft.server.maxConcurrentRequests},${initialDraft.server.maxQueuedRequests},${initialDraft.server.maxQueuedRequestsPerUser},${initialDraft.server.requestQueueTimeoutSeconds}`);
  const [executionText, setExecutionText] = useState(`${initialDraft.execution.enabled},${initialDraft.execution.networkDefault},${initialDraft.execution.timeoutSeconds},${initialDraft.execution.maxMemoryMb},${initialDraft.execution.maxProcesses}`);
  const [multiAgentText, setMultiAgentText] = useState(`${initialDraft.multiAgent.enabled},${initialDraft.multiAgent.maxConcurrent},${initialDraft.multiAgent.maxIterations},${initialDraft.multiAgent.defaultBackground},${initialDraft.multiAgent.autoContinueOnComplete}`);
  const [vllmRuntimeText, setVllmRuntimeText] = useState(`${initialDraft.vllmRuntime.image},${initialDraft.vllmRuntime.gpuMemoryUtilization},${initialDraft.vllmRuntime.maxModelLen},${initialDraft.vllmRuntime.tensorParallelSize},${initialDraft.vllmRuntime.quantization},${initialDraft.vllmRuntime.gpuDevices},${initialDraft.vllmRuntime.toolCallParser},${initialDraft.vllmRuntime.reasoningParser}`);
  const [accessFocus, setAccessFocus] = useState(0);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpImage, setMcpImage] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpFocus, setMcpFocus] = useState(0);
  const [warning, setWarning] = useState("");
  const [fieldError, setFieldError] = useState("");
  // Step bar focus: ↑ from a screen's top row lands here.
  const [barFocus, setBarFocus] = useState(false);
  const [barCursor, setBarCursor] = useState(0);
  // Remount key for selector widgets so start-over resets their cursor.
  const [generation, setGeneration] = useState(0);

  const dockerOk = checks.docker && checks.compose;
  const enabled = draft.enabled;

  const currentProvider = (screen.includes(":") ? screen.split(":")[1] : undefined) as ProviderId | undefined;
  const meta = currentProvider ? META[currentProvider] : undefined;

  const providerDone = (id: ProviderId) => draft.providers[id].models.length > 0 && (id === "vllm" || !!draft.providers[id].apiKey);
  const configComplete = enabled.length > 0 && enabled.every(providerDone);
  const configuredCount = enabled.filter(providerDone).length;
  // With several providers the default must be an explicit choice (d key).
  const defaultExplicit = enabled.some((id) => providerDone(id) && draft.providers[id].models.some((model) => modelId(id, model) === draft.defaultModel));
  const reviewReady = configComplete && (configuredCount < 2 || defaultExplicit);

  const step = screen === "access" || screen.startsWith("settings-") ? 1 : screen === "mcp" || screen.startsWith("mcp-add") ? 2 : screen === "review" ? 3 : 0;
  const reachable = [true, true, configComplete, reviewReady];

  const onFieldScreen = screen.startsWith("key:") || screen.startsWith("endpoint:") || screen.startsWith("settings-") || screen.startsWith("mcp-add") || (screen.startsWith("model:") && customModel);

  const modelOptions = useMemo(() => {
    if (!meta || !currentProvider) return [];
    const current = draft.providers[currentProvider].models;
    const configured = current.map((value) => ({ label: value, value, detail: "configured" }));
    const known = meta.models.filter((option) => option.value && !current.includes(option.value));
    return [...configured, ...known, ...meta.models.filter((option) => !option.value)];
  }, [meta, currentProvider, draft]);

  const finish = (outcome: WizardOutcome, next: DeploymentDraft = draft) => {
    onDone(outcome, next);
    exit();
  };

  const persist = (next: DeploymentDraft) => {
    setDraft(next);
    onPersist(next);
  };

  /** Move to a screen, priming its text fields from the draft. */
  const enterScreen = (target: Screen, from: DeploymentDraft = draft) => {
    setWarning("");
    setFieldError("");
    setBarFocus(false);
    if (target.startsWith("model:")) {
      const id = target.split(":")[1] as ProviderId;
      setCustomModel(true);
      setModelText(from.providers[id].models.join(", "));
      setDefaultModelText(from.defaultModel);
      setModelFocus(0);
    }
    if (target.startsWith("key:")) setKeyText(from.providers[target.split(":")[1] as ProviderId].apiKey);
    if (target.startsWith("endpoint:")) setEndpointText(from.providers[target.split(":")[1] as ProviderId].apiBase);
    if (target === "access" || target.startsWith("settings-")) {
      setAccessFocus(0);
      setVisionSupportedText(Object.entries(from.visionCapabilities).filter(([, value]) => value === "supported").map(([model]) => model).join(","));
      setVisionUnsupportedText(Object.entries(from.visionCapabilities).filter(([, value]) => value === "unsupported").map(([model]) => model).join(","));
      setBindText(from.bindAddress);
      setAgentText(`${from.agent.temperature},${from.agent.maxIterations},${from.agent.providerMaxRetries},${from.agent.codeTimeout}`);
      setServerText(`${from.server.maxLiveSessions},${from.server.maxLiveSessionsPerUser},${from.server.maxConcurrentRequests},${from.server.maxQueuedRequests},${from.server.maxQueuedRequestsPerUser},${from.server.requestQueueTimeoutSeconds}`);
      setExecutionText(`${from.execution.enabled},${from.execution.networkDefault},${from.execution.timeoutSeconds},${from.execution.maxMemoryMb},${from.execution.maxProcesses}`);
      setMultiAgentText(`${from.multiAgent.enabled},${from.multiAgent.maxConcurrent},${from.multiAgent.maxIterations},${from.multiAgent.defaultBackground},${from.multiAgent.autoContinueOnComplete}`);
      setVllmRuntimeText(`${from.vllmRuntime.image},${from.vllmRuntime.gpuMemoryUtilization},${from.vllmRuntime.maxModelLen},${from.vllmRuntime.tensorParallelSize},${from.vllmRuntime.quantization},${from.vllmRuntime.gpuDevices},${from.vllmRuntime.toolCallParser},${from.vllmRuntime.reasoningParser}`);
    }
    if (target.startsWith("mcp-add")) {
      setMcpName("");
      setMcpUrl("");
      setMcpImage("");
      setMcpCommand("");
      setMcpFocus(0);
    }
    setScreen(target);
  };

  const goBack = () => {
    if (screen.startsWith("model:") && customModel) return enterScreen(`menu:${currentProvider}`);
    if (screen.startsWith("model:") || screen.startsWith("key:") || screen.startsWith("endpoint:")) return enterScreen(`menu:${currentProvider}`);
    if (screen.startsWith("menu:")) return enterScreen("providers");
    if (screen.startsWith("settings-")) return enterScreen("access");
    if (screen === "access") return enterScreen("providers");
    if (screen.startsWith("mcp-add")) return enterScreen("mcp");
    if (screen === "mcp") return enterScreen("access");
    if (screen === "review") return enterScreen("mcp");
    finish("quit"); // providers
  };

  const jumpTo = (stepIndex: number) => {
    if (!reachable[stepIndex]) {
      const pending = enabled.filter((id) => !providerDone(id)).map((id) => META[id].label);
      setWarning(
        !configComplete
          ? `Review is locked — finish setup for ${pending.join(", ") || "at least one provider"} first.`
          : "Review is locked — pick a default model: press d on a model inside a provider.",
      );
      return;
    }
    if (stepIndex === 0) return enterScreen("providers");
    if (stepIndex === 1) return enterScreen("access");
    if (stepIndex === 2) return enterScreen("mcp");
    const next = { ...draft };
    // Single configured provider: its model is the default, no d needed.
    if (!defaultExplicit) {
      const only = enabled.filter(providerDone)[0]!;
      next.defaultModel = modelId(only, next.providers[only].models[0]!);
      persist(next);
    }
    enterScreen("review", next);
  };

  const startOver = () => {
    const fresh = freshDraft();
    setDraft(fresh);
    setSource("fresh");
    setAdminText(fresh.adminUsers);
    setPortText(String(fresh.port));
    setWorkspaceText(fresh.workspaceRoot);
    setDataText(fresh.dataDir);
    setBindText(fresh.bindAddress);
    setVisionSupportedText("");
    setVisionUnsupportedText("");
    setAgentText(`${fresh.agent.temperature},${fresh.agent.maxIterations},${fresh.agent.providerMaxRetries},${fresh.agent.codeTimeout}`);
    setServerText(`${fresh.server.maxLiveSessions},${fresh.server.maxLiveSessionsPerUser},${fresh.server.maxConcurrentRequests},${fresh.server.maxQueuedRequests},${fresh.server.maxQueuedRequestsPerUser},${fresh.server.requestQueueTimeoutSeconds}`);
    setExecutionText(`${fresh.execution.enabled},${fresh.execution.networkDefault},${fresh.execution.timeoutSeconds},${fresh.execution.maxMemoryMb},${fresh.execution.maxProcesses}`);
    setMultiAgentText(`${fresh.multiAgent.enabled},${fresh.multiAgent.maxConcurrent},${fresh.multiAgent.maxIterations},${fresh.multiAgent.defaultBackground},${fresh.multiAgent.autoContinueOnComplete}`);
    setVllmRuntimeText(`${fresh.vllmRuntime.image},${fresh.vllmRuntime.gpuMemoryUtilization},${fresh.vllmRuntime.maxModelLen},${fresh.vllmRuntime.tensorParallelSize},${fresh.vllmRuntime.quantization},${fresh.vllmRuntime.gpuDevices},${fresh.vllmRuntime.toolCallParser},${fresh.vllmRuntime.reasoningParser}`);
    setMcpName("");
    setMcpUrl("");
    setMcpImage("");
    setMcpCommand("");
    setCustomModel(false);
    setWarning("");
    setFieldError("");
    setBarFocus(false);
    setScreen("providers");
    setGeneration((g) => g + 1);
  };

  const focusBar = () => {
    setBarCursor(step);
    setBarFocus(true);
  };

  // Global keys. Ctrl+n / ctrl+p step forward/back from anywhere, fields
  // included (Ctrl+digit doesn't exist as a terminal key). ↑ from a
  // screen's top row focuses the step bar. Plain `r` only where it can't
  // collide with typing. Esc backs out of field screens (selector screens
  // handle Esc themselves).
  useInput((input, key) => {
    if (key.ctrl && input === "n") return jumpTo(Math.min(step + 1, 3));
    if (key.ctrl && input === "p") return jumpTo(Math.max(step - 1, 0));
    if (barFocus) {
      if (key.leftArrow) return setBarCursor((prev) => (prev + STEPS.length - 1) % STEPS.length);
      if (key.rightArrow || key.tab) return setBarCursor((prev) => (prev + 1) % STEPS.length);
      if (key.return) return jumpTo(barCursor);
      if (key.downArrow || key.escape) return setBarFocus(false);
      return;
    }
    if (screen.startsWith("model:") && customModel) {
      if (key.upArrow) {
        setFieldError("");
        return modelFocus === 0 ? focusBar() : setModelFocus(modelFocus - 1);
      }
      if (key.downArrow) {
        setFieldError("");
        return setModelFocus(Math.min(1, modelFocus + 1));
      }
    }
    if (screen.startsWith("settings-")) {
      const fields = screen === "settings-basic"
        ? SETTINGS_FIELDS
        : screen === "settings-capabilities"
          ? 2
          : screen === "settings-agent"
            ? 4
            : screen === "settings-capacity"
              ? 6
              : screen === "settings-execution"
                ? 5
                : screen === "settings-multi-agent"
                  ? 5
                  : 8;
      if (key.upArrow) {
        setFieldError("");
        return accessFocus === 0 ? focusBar() : setAccessFocus(accessFocus - 1);
      }
      if (key.downArrow) {
        setFieldError("");
        return setAccessFocus(Math.min(fields - 1, accessFocus + 1));
      }
    }
    if (screen.startsWith("mcp-add")) {
      const fields = screen === "mcp-add-container" ? 3 : 2;
      if (key.upArrow) {
        setFieldError("");
        return mcpFocus === 0 ? focusBar() : setMcpFocus(mcpFocus - 1);
      }
      if (key.downArrow) {
        setFieldError("");
        return setMcpFocus(Math.min(fields - 1, mcpFocus + 1));
      }
    }
    if (key.upArrow && onFieldScreen) return focusBar();
    if (key.escape && onFieldScreen) return goBack();
    if (onFieldScreen) return;
    if (input === "r") return startOver();
  });

  /* ── Submit handlers ─────────────────────────────────── */

  const toggleProvider = (index: number) => {
    const id = PROVIDERS[index]!.id;
    if (id === "vllm" && !enabled.includes("vllm") && (!checks.gpu || !checks.nvidiaRuntime)) {
      setWarning("vLLM needs an NVIDIA GPU and the NVIDIA Container Toolkit on this host.");
      return;
    }
    setWarning("");
    const nextEnabled = enabled.includes(id)
      ? enabled.filter((p) => p !== id)
      : PROVIDER_IDS.filter((p) => enabled.includes(p) || p === id);
    persist({ ...draft, enabled: nextEnabled });
  };

  const openProvider = (index: number) => {
    const id = PROVIDERS[index]!.id;
    if (id === "vllm" && !enabled.includes("vllm") && (!checks.gpu || !checks.nvidiaRuntime)) {
      setWarning("vLLM needs an NVIDIA GPU and the NVIDIA Container Toolkit on this host.");
      return;
    }
    // Opening a provider is inspection only. It must not make an incomplete
    // provider block Review; enabling happens when the user toggles it or
    // saves a model/key/endpoint value.
    enterScreen(`menu:${id}`);
  };

  const enableProvider = (next: DeploymentDraft, id: ProviderId): DeploymentDraft =>
    next.enabled.includes(id) ? next : { ...next, enabled: PROVIDER_IDS.filter((provider) => next.enabled.includes(provider) || provider === id) };

  const activateWhenReady = (next: DeploymentDraft, id: ProviderId): DeploymentDraft => {
    const provider = next.providers[id];
    const ready = provider.models.length > 0 && (id === "vllm" || !!provider.apiKey);
    return ready ? enableProvider(next, id) : next;
  };

  const submitMenu = (index: number) => {
    const id = currentProvider!;
    if (index === 0) return enterScreen(`model:${id}`);
    if (id !== "vllm" && index === 1) return enterScreen(`key:${id}`);
    if (id === "vllm" && index === 1) return enterScreen(`endpoint:${id}`);
    if (id !== "vllm" && index === 2) return enterScreen(`endpoint:${id}`);
    enterScreen("providers");
  };

  const applyModel = (value: string, asDefault = false) => {
    const id = currentProvider!;
    setCustomModel(false);
    const models = draft.providers[id].models.includes(value) ? draft.providers[id].models : [...draft.providers[id].models, value];
    const next = activateWhenReady({
      ...draft,
      providers: { ...draft.providers, [id]: { ...draft.providers[id], models } },
      ...(asDefault ? { defaultModel: modelId(id, value) } : {}),
    }, id);
    persist(next);
    enterScreen(`menu:${id}`, next);
  };

  const submitModel = (index: number, asDefault = false) => {
    const option = modelOptions[index]!;
    if (!option.value) {
      setModelText(draft.providers[currentProvider!].models.join(", "));
      setCustomModel(true);
      return;
    }
    applyModel(option.value, asDefault);
  };

  const submitCustomModel = () => {
    const values = modelText.split(",").map((value) => value.trim()).filter(Boolean);
    if (!values.length) return setFieldError("Enter at least one model ID, or press Esc to go back.");
    // API providers need their litellm prefix; add it when the user typed
    // the bare model name. vLLM keeps the raw Hugging Face repo ID — the
    // hosted_vllm/ prefix is applied by modelId() when writing config.
    const id = currentProvider!;
    const models = values.map((value) => id !== "vllm" && !value.startsWith(`${id}/`) ? `${id}/${value}` : value);
    setModelText(models.join(", "));
    setModelFocus(1);
  };

  const submitDefaultModel = () => {
    const id = currentProvider!;
    const models = modelText.split(",").map((value) => value.trim()).filter(Boolean).map((value) => id !== "vllm" && !value.startsWith(`${id}/`) ? `${id}/${value}` : value);
    if (!models.length) return setFieldError("Enter at least one model ID first.");
    let value = defaultModelText.trim();
    if (!value) value = models[0]!;
    const rawDefault = id === "vllm" ? value.replace(/^hosted_vllm\//, "") : value.startsWith(`${id}/`) ? value : `${id}/${value}`;
    if (!models.includes(rawDefault)) return setFieldError("Default model must be one of the configured model IDs.");
    const next = activateWhenReady({ ...draft, providers: { ...draft.providers, [id]: { ...draft.providers[id], models } }, defaultModel: modelId(id, rawDefault) }, id);
    persist(next);
    setCustomModel(false);
    enterScreen(`menu:${id}`, next);
  };

  const submitKey = () => {
    const value = keyText.trim();
    if (!value) return setFieldError(`${meta!.keyLabel} is required for ${meta!.label}.`);
    const id = currentProvider!;
    const next = activateWhenReady({ ...draft, providers: { ...draft.providers, [id]: { ...draft.providers[id], apiKey: value } } }, id);
    persist(next);
    enterScreen(`menu:${id}`, next);
  };

  const submitEndpoint = () => {
    const id = currentProvider!;
    const value = endpointText.trim();
    if (value) {
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        return setFieldError("Endpoint must be a valid http(s) URL, or blank for managed local vLLM.");
      }
    }
    const next = activateWhenReady({ ...draft, providers: { ...draft.providers, [id]: { ...draft.providers[id], apiBase: value } } }, id);
    persist(next);
    enterScreen(`menu:${id}`, next);
  };

  const commitAllSettings = () => {
    if (!/^\d+$/.test(portText.trim()) || Number(portText) < 1 || Number(portText) > 65535) {
      setAccessFocus(1);
      return setFieldError("Port must be a number between 1 and 65535.");
    }
    if (!workspaceText.trim()) {
      setAccessFocus(2);
      return setFieldError("Workspace location is required — ./workspace keeps the current behavior.");
    }
    if (!bindText.trim()) {
      setAccessFocus(4);
      return setFieldError("Bind address is required; use 127.0.0.1 for local-only access or 0.0.0.0 for network access.");
    }
    const tuple = (raw: string, count: number, label: string) => {
      const values = raw.split(",").map((value) => value.trim());
      if (values.length !== count || values.some((value) => !value)) throw new Error(`${label} needs ${count} comma-separated values.`);
      return values;
    };
    const numberAt = (value: string, label: string, min = 0) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${label} must be a number >= ${min}.`);
      return parsed;
    };
    const booleanAt = (value: string, label: string) => {
      if (value !== "true" && value !== "false") throw new Error(`${label} must be true or false.`);
      return value === "true";
    };
    let agent: DeploymentDraft["agent"];
    let server: DeploymentDraft["server"];
    let execution: DeploymentDraft["execution"];
    let multiAgent: DeploymentDraft["multiAgent"];
    let vllmRuntime: DeploymentDraft["vllmRuntime"];
    try {
      const agentValues = tuple(agentText, 4, "Agent settings");
      agent = {
        temperature: String(numberAt(agentValues[0]!, "Temperature")),
        maxIterations: numberAt(agentValues[1]!, "Agent max iterations", 1),
        providerMaxRetries: numberAt(agentValues[2]!, "Provider retries"),
        codeTimeout: numberAt(agentValues[3]!, "Code timeout", 1),
      };
      const serverValues = tuple(serverText, 6, "Server capacity");
      server = {
        maxLiveSessions: numberAt(serverValues[0]!, "Max live sessions", 1),
        maxLiveSessionsPerUser: numberAt(serverValues[1]!, "Max live sessions per user", 1),
        maxConcurrentRequests: numberAt(serverValues[2]!, "Max concurrent requests", 1),
        maxQueuedRequests: numberAt(serverValues[3]!, "Max queued requests"),
        maxQueuedRequestsPerUser: numberAt(serverValues[4]!, "Max queued requests per user"),
        requestQueueTimeoutSeconds: numberAt(serverValues[5]!, "Queue timeout", 1),
      };
      if (server.maxLiveSessionsPerUser > server.maxLiveSessions) throw new Error("Per-user live sessions cannot exceed total live sessions.");
      const executionValues = tuple(executionText, 5, "Execution settings");
      if (executionValues[1] !== "deny" && executionValues[1] !== "allow_domains") throw new Error("Execution network must be deny or allow_domains.");
      execution = {
        enabled: booleanAt(executionValues[0]!, "Execution enabled"),
        networkDefault: executionValues[1] as "deny" | "allow_domains",
        timeoutSeconds: numberAt(executionValues[2]!, "Execution timeout", 1),
        maxMemoryMb: numberAt(executionValues[3]!, "Execution memory", 1),
        maxProcesses: numberAt(executionValues[4]!, "Execution processes", 1),
      };
      const multiValues = tuple(multiAgentText, 5, "Multi-agent settings");
      multiAgent = {
        enabled: booleanAt(multiValues[0]!, "Multi-agent enabled"),
        maxConcurrent: numberAt(multiValues[1]!, "Multi-agent concurrency", 1),
        maxIterations: numberAt(multiValues[2]!, "Multi-agent iterations", 1),
        defaultBackground: booleanAt(multiValues[3]!, "Multi-agent background"),
        autoContinueOnComplete: booleanAt(multiValues[4]!, "Multi-agent auto-continue"),
      };
      const vllmValues = vllmRuntimeText.split(",").map((value) => value.trim());
      if (vllmValues.length !== 8 || !vllmValues[0] || !vllmValues[1] || !vllmValues[3] || !vllmValues[5]) throw new Error("vLLM runtime needs 8 comma-separated values; max model length and quantization may be blank.");
      vllmRuntime = {
        image: vllmValues[0]!,
        gpuMemoryUtilization: vllmValues[1]!,
        maxModelLen: vllmValues[2]!,
        tensorParallelSize: numberAt(vllmValues[3]!, "Tensor parallel size", 1),
        quantization: vllmValues[4]!,
        gpuDevices: vllmValues[5]!,
        toolCallParser: vllmValues[6]!,
        reasoningParser: vllmValues[7]!,
      };
    } catch (error) {
      return setFieldError(error instanceof Error ? error.message : "Check the advanced deployment settings.");
    }
    const capabilities: DeploymentDraft["visionCapabilities"] = {};
    for (const model of visionSupportedText.split(",").map((value) => value.trim()).filter(Boolean)) capabilities[model] = "supported";
    for (const model of visionUnsupportedText.split(",").map((value) => value.trim()).filter(Boolean)) capabilities[model] = "unsupported";
    const next = {
      ...draft,
      adminUsers: adminText.trim(),
      port: Number(portText),
      workspaceRoot: workspaceText.trim(),
      dataDir: dataText.trim(),
      bindAddress: bindText.trim(),
      visionCapabilities: capabilities,
      agent,
      server,
      execution,
      multiAgent,
      vllmRuntime,
    };
    if (!configComplete) {
      persist(next);
      enterScreen("providers", next);
      setWarning("Finish configuring your enabled providers to reach Review.");
      return;
    }
    if (!next.defaultModel || !enabled.some((id) => next.providers[id].models.some((model) => modelId(id, model) === next.defaultModel))) {
      const first = enabled.filter(providerDone)[0]!;
      next.defaultModel = modelId(first, next.providers[first].models[0]!);
    }
    persist(next);
    enterScreen("mcp", next);
  };

  const submitBasicSettings = () => {
    if (accessFocus < SETTINGS_FIELDS - 1) return setAccessFocus(accessFocus + 1);
    if (!/^\d+$/.test(portText.trim()) || Number(portText) < 1 || Number(portText) > 65535) {
      setAccessFocus(1);
      return setFieldError("Port must be a number between 1 and 65535.");
    }
    if (!workspaceText.trim()) {
      setAccessFocus(2);
      return setFieldError("Workspace location is required — ./workspace keeps the current behavior.");
    }
    if (!bindText.trim()) {
      setAccessFocus(4);
      return setFieldError("Bind address is required; use 127.0.0.1 for local-only access or 0.0.0.0 for network access.");
    }
    const next = { ...draft, adminUsers: adminText.trim(), port: Number(portText), workspaceRoot: workspaceText.trim(), dataDir: dataText.trim(), bindAddress: bindText.trim() };
    persist(next);
    enterScreen("access", next);
  };

  const submitSettingsMenu = (index: number) => {
    const screens = ["settings-basic", "settings-capabilities", "settings-agent", "settings-capacity", "settings-execution", "settings-multi-agent", "settings-vllm"];
    if (index < screens.length) return enterScreen(screens[index]!);
    commitAllSettings();
  };

  const submitAdvancedSettings = () => {
    const values = (raw: string, count: number, label: string) => {
      const parts = raw.split(",").map((value) => value.trim());
      if (parts.length !== count || parts.some((value) => !value)) throw new Error(`${label} needs ${count} comma-separated values.`);
      return parts;
    };
    const numberValue = (value: string, label: string, min = 0) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${label} must be a number >= ${min}.`);
      return parsed;
    };
    const booleanValue = (value: string, label: string) => {
      if (value !== "true" && value !== "false") throw new Error(`${label} must be true or false.`);
      return value === "true";
    };
    try {
      let next = draft;
      if (screen === "settings-capabilities") {
        const capabilities: DeploymentDraft["visionCapabilities"] = {};
        for (const model of visionSupportedText.split(",").map((value) => value.trim()).filter(Boolean)) capabilities[model] = "supported";
        for (const model of visionUnsupportedText.split(",").map((value) => value.trim()).filter(Boolean)) capabilities[model] = "unsupported";
        next = { ...next, visionCapabilities: capabilities };
      } else if (screen === "settings-agent") {
        const parts = values(agentText, 4, "Agent settings");
        next = { ...next, agent: { temperature: String(numberValue(parts[0]!, "Temperature")), maxIterations: numberValue(parts[1]!, "Agent max iterations", 1), providerMaxRetries: numberValue(parts[2]!, "Provider retries"), codeTimeout: numberValue(parts[3]!, "Code timeout", 1) } };
      } else if (screen === "settings-capacity") {
        const parts = values(serverText, 6, "Server capacity");
        const server = { maxLiveSessions: numberValue(parts[0]!, "Max live sessions", 1), maxLiveSessionsPerUser: numberValue(parts[1]!, "Max live sessions per user", 1), maxConcurrentRequests: numberValue(parts[2]!, "Max concurrent requests", 1), maxQueuedRequests: numberValue(parts[3]!, "Max queued requests"), maxQueuedRequestsPerUser: numberValue(parts[4]!, "Max queued requests per user"), requestQueueTimeoutSeconds: numberValue(parts[5]!, "Queue timeout", 1) };
        if (server.maxLiveSessionsPerUser > server.maxLiveSessions) throw new Error("Per-user live sessions cannot exceed total live sessions.");
        next = { ...next, server };
      } else if (screen === "settings-execution") {
        const parts = values(executionText, 5, "Execution settings");
        if (parts[1] !== "deny" && parts[1] !== "allow_domains") throw new Error("Execution network must be deny or allow_domains.");
        next = { ...next, execution: { enabled: booleanValue(parts[0]!, "Execution enabled"), networkDefault: parts[1] as "deny" | "allow_domains", timeoutSeconds: numberValue(parts[2]!, "Execution timeout", 1), maxMemoryMb: numberValue(parts[3]!, "Execution memory", 1), maxProcesses: numberValue(parts[4]!, "Execution processes", 1) } };
      } else if (screen === "settings-multi-agent") {
        const parts = values(multiAgentText, 5, "Multi-agent settings");
        next = { ...next, multiAgent: { enabled: booleanValue(parts[0]!, "Multi-agent enabled"), maxConcurrent: numberValue(parts[1]!, "Multi-agent concurrency", 1), maxIterations: numberValue(parts[2]!, "Multi-agent iterations", 1), defaultBackground: booleanValue(parts[3]!, "Multi-agent background"), autoContinueOnComplete: booleanValue(parts[4]!, "Multi-agent auto-continue") } };
      } else if (screen === "settings-vllm") {
        const parts = vllmRuntimeText.split(",").map((value) => value.trim());
        if (parts.length !== 8 || !parts[0] || !parts[1] || !parts[3] || !parts[5]) throw new Error("vLLM runtime needs 8 comma-separated values; max model length and quantization may be blank.");
        next = { ...next, vllmRuntime: { image: parts[0]!, gpuMemoryUtilization: parts[1]!, maxModelLen: parts[2]!, tensorParallelSize: numberValue(parts[3]!, "Tensor parallel size", 1), quantization: parts[4]!, gpuDevices: parts[5]!, toolCallParser: parts[6]!, reasoningParser: parts[7]! } };
      }
      persist(next);
      enterScreen("access", next);
    } catch (error) {
      setFieldError(error instanceof Error ? error.message : "Check the setting value.");
    }
  };

  const submitAccess = (index: number) => {
    if (index === 0) return enterScreen("settings-basic");
    if (index === 1) return enterScreen("settings-capabilities");
    if (index === 2) return enterScreen("settings-agent");
    if (index === 3) return enterScreen("settings-capacity");
    if (index === 4) return enterScreen("settings-execution");
    if (index === 5) return enterScreen("settings-multi-agent");
    if (index === 6) return enterScreen("settings-vllm");
    commitAllSettings();
  };

  const settingPart = (raw: string, index: number): string => raw.split(",")[index]?.trim() ?? "";

  const updateSettingPart = (
    raw: string,
    index: number,
    count: number,
    value: string,
    setValue: (next: string) => void,
  ) => {
    const parts = raw.split(",");
    while (parts.length < count) parts.push("");
    parts[index] = value;
    setValue(parts.join(","));
    setFieldError("");
  };

  const submitSettingField = (fieldCount: number) => {
    if (accessFocus < fieldCount - 1) return setAccessFocus(accessFocus + 1);
    submitAdvancedSettings();
  };

  const mcpId = (name: string) => {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
    let id = base.slice(0, 64);
    let suffix = 2;
    while (draft.mcpServers.some((server) => server.id === id)) id = `${base.slice(0, 60)}-${suffix++}`;
    return id;
  };

  const addMcp = () => {
    const isContainer = screen === "mcp-add-container";
    const lastField = isContainer ? 2 : 1;
    if (mcpFocus < lastField) return setMcpFocus(mcpFocus + 1);
    const name = mcpName.trim();
    if (!name) {
      setMcpFocus(0);
      return setFieldError("Integration name is required.");
    }
    let server: McpBootstrapServer;
    if (isContainer) {
      const image = mcpImage.trim();
      if (!image.includes("@sha256:") || !/@sha256:[a-fA-F0-9]{64}$/.test(image)) {
        setMcpFocus(1);
        return setFieldError("Use an immutable image pinned by a 64-character sha256 digest.");
      }
      const parts = mcpCommand.trim().split(/\s+/).filter(Boolean);
      server = {
        id: mcpId(name), name, transport: "container_stdio", image,
        command: parts.length ? [parts[0]!] : [], args: parts.slice(1),
        availability: "everyone", enabled: true, auth_mode: "none",
      };
    } else {
      const url = mcpUrl.trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return setFieldError("Enter a valid http(s) MCP URL.");
      }
      if (!["http:", "https:"].includes(parsed.protocol)) return setFieldError("MCP URL must use http or https.");
      server = {
        id: mcpId(name), name, transport: "streamable_http", url,
        availability: "everyone", enabled: true, auth_mode: "none",
      };
    }
    const next = { ...draft, mcpServers: [...draft.mcpServers, server] };
    persist(next);
    enterScreen("mcp", next);
  };

  const submitMcp = (index: number) => {
    if (index === draft.mcpServers.length) return enterScreen("mcp-add-remote");
    if (index === draft.mcpServers.length + 1) return enterScreen("mcp-add-container");
    if (index === draft.mcpServers.length + 2) return jumpTo(3);
    const next = {
      ...draft,
      mcpServers: draft.mcpServers.map((server, i) => i === index ? { ...server, enabled: !server.enabled } : server),
    };
    persist(next);
  };

  const removeMcp = (index: number) => {
    if (index >= draft.mcpServers.length) return;
    persist({ ...draft, mcpServers: draft.mcpServers.filter((_, i) => i !== index) });
  };

  /* ── Screens ─────────────────────────────────────────── */

  const widgetsActive = !barFocus;

  const body = (() => {
    if (!dockerOk) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.status.error}>
            {checks.docker ? "Docker Compose is missing." : "Docker Engine is missing."}
          </Text>
          <Text color={theme.text.secondary}>
            Install Docker Engine and the Compose plugin, then run scout deploy again.
          </Text>
        </Box>
      );
    }

    if (screen === "providers") {
      const incomplete = enabled.filter((id) => !providerDone(id));
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            Which providers should this deployment offer?
          </Text>
          <ToggleRow
            key={`providers-${generation}`}
            options={PROVIDERS.map((p) => ({ label: p.label, tag: p.tag, blurb: p.blurb }))}
            checked={PROVIDERS.map((p) => enabled.includes(p.id))}
            onToggle={toggleProvider}
            onSubmit={openProvider}
            onBack={goBack}
            onUp={focusBar}
            isActive={widgetsActive}
          />
          {warning ? (
            <Text color={theme.status.warning}>{warning}</Text>
          ) : incomplete.length > 0 ? (
            <Text color={theme.status.warning}>
              Incomplete — {incomplete.map((id) => META[id].label).join(", ")}: press ↵ to finish setup.
            </Text>
          ) : enabled.length === 0 ? (
            <Text color={theme.text.secondary}>Space enables a provider; ↵ opens it to set its model and API key.</Text>
          ) : null}
        </Box>
      );
    }

    if (screen.startsWith("menu:") && meta) {
      const config = draft.providers[meta.id];
      const done = providerDone(meta.id);
      const chips = [
        { label: "Models", blurb: config.models.join(", ") || "not set" },
        ...(meta.id === "vllm" ? [{ label: "Endpoint", blurb: config.apiBase || "managed local vLLM" }] : [{ label: "API key", blurb: config.apiKey ? "••• set" : "not set" }, { label: "Endpoint", blurb: config.apiBase || "provider default" }]),
      ];
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            {meta.label}
            <Text color={done ? theme.text.secondary : theme.status.warning} bold={false}>
              {" "}
              — {done ? "Configured" : "Incomplete"}
            </Text>
          </Text>
          <CardRow
            key={`menu-${meta.id}-${generation}`}
            options={chips}
            checked={[config.models.length > 0, ...(meta.id === "vllm" ? [!!config.apiBase] : [!!config.apiKey, !!config.apiBase])]}
            onSubmit={submitMenu}
            onBack={goBack}
            onUp={focusBar}
            isActive={widgetsActive}
          />
        </Box>
      );
    }

    if (screen.startsWith("model:") && meta) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            {meta.label} <Text color={theme.text.secondary}>·</Text> Model
          </Text>
          <Box flexDirection="column" gap={1}>
            <Field
              label={meta.id === "vllm" ? "Hugging Face model IDs (comma-separated)" : "Model IDs (comma-separated)"}
              value={modelText}
              placeholder={`e.g. ${meta.example},another-model`}
              focused={widgetsActive && modelFocus === 0}
              error={modelFocus === 0 ? fieldError : undefined}
              onChange={(value) => {
                setModelText(value);
                setFieldError("");
              }}
              onSubmit={submitCustomModel}
            />
            <Field
              label="Default model ID"
              value={defaultModelText}
              placeholder="leave blank to use the first model"
              focused={widgetsActive && modelFocus === 1}
              error={modelFocus === 1 ? fieldError : undefined}
              onChange={(value) => {
                setDefaultModelText(value);
                setFieldError("");
              }}
              onSubmit={submitDefaultModel}
            />
            <Text color={theme.text.secondary}>{meta.idHint} Add models by separating IDs with commas.</Text>
          </Box>
        </Box>
      );
    }

    if (screen.startsWith("key:") && meta) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            {meta.label} <Text color={theme.text.secondary}>·</Text> API key
          </Text>
          <Field
            label={meta.keyLabel ?? "API key"}
            value={keyText}
            placeholder="paste your key"
            mask
            focused={widgetsActive}
            error={fieldError}
            onChange={(value) => {
              setKeyText(value);
              setFieldError("");
            }}
            onSubmit={submitKey}
          />
          <Text color={theme.text.secondary}>Stored in .env (mode 600) on this machine only.</Text>
        </Box>
      );
    }

    if (screen.startsWith("endpoint:") && meta) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            {meta.label} <Text color={theme.text.secondary}>·</Text> Endpoint
          </Text>
          <Field
            label="API base URL — blank uses the managed local vLLM service"
            value={endpointText}
            placeholder={meta.id === "vllm" ? "blank = Docker-managed vLLM" : "provider default"}
            focused={widgetsActive}
            error={fieldError}
            onChange={(value) => { setEndpointText(value); setFieldError(""); }}
            onSubmit={submitEndpoint}
          />
          <Text color={theme.text.secondary}>Use an http(s) URL reachable from the Scout container.</Text>
        </Box>
      );
    }

    if (screen === "access") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>Deployment settings</Text>
          <Text color={theme.text.secondary}>Choose a settings group. Changes are saved when you leave each group.</Text>
          <SelectList
            key={`settings-menu-${generation}`}
            options={[
              { label: "Basic deployment", detail: "admin, port, storage, network exposure" },
              { label: "Model capabilities", detail: "tell Scout which models can process images" },
              { label: "Agent behavior", detail: "how long Scout thinks and retries model calls" },
              { label: "Server capacity", detail: "limits for users, sessions, and waiting requests" },
              { label: "Code execution", detail: "whether generated code may run and its limits" },
              { label: "Multi-agent", detail: "background work and how many tasks run together" },
              { label: "vLLM runtime", detail: "GPU service options; change only for custom models" },
              { label: "Use current values and continue", detail: "skip tuning; keep the values shown in this draft" },
            ]}
            onSubmit={submitAccess}
            onBack={goBack}
            onUp={focusBar}
            isActive={widgetsActive}
          />
        </Box>
      );
    }

    if (screen === "settings-basic") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            Deployment settings
          </Text>
          <Field
            label="Admin usernames · optional · default: first registered user"
            value={adminText}
            placeholder="defaults to the first registered user"
            focused={widgetsActive && accessFocus === 0}
            onChange={setAdminText}
            onSubmit={submitBasicSettings}
          />
          <Field
            label={`Public Scout port · browser/API port · default: ${initialDraft.port}`}
            value={portText}
            placeholder={`default: ${initialDraft.port}`}
            focused={widgetsActive && accessFocus === 1}
            error={accessFocus === 1 ? fieldError : undefined}
            onChange={(value) => {
              setPortText(value);
              setFieldError("");
            }}
            onSubmit={submitBasicSettings}
          />
          <Field
            label={`Workspace location · users/ and shared/ live here · default: ${initialDraft.workspaceRoot}`}
            value={workspaceText}
            placeholder={`default: ${initialDraft.workspaceRoot}`}
            focused={widgetsActive && accessFocus === 2}
            error={accessFocus === 2 ? fieldError : undefined}
            onChange={(value) => {
              setWorkspaceText(value);
              setFieldError("");
            }}
            onSubmit={submitBasicSettings}
          />
          <Field
            label="Server data · database and sessions · default: Docker volume"
            value={dataText}
            placeholder="default: Docker volume (scout-data)"
            focused={widgetsActive && accessFocus === 3}
            onChange={setDataText}
            onSubmit={submitBasicSettings}
          />
          <Field
            label={`Bind address · network exposure · default: ${initialDraft.bindAddress}`}
            value={bindText}
            placeholder={`default: ${initialDraft.bindAddress}`}
            focused={widgetsActive && accessFocus === 4}
            error={accessFocus === 4 ? fieldError : undefined}
            onChange={(value) => { setBindText(value); setFieldError(""); }}
            onSubmit={submitBasicSettings}
          />
        </Box>
      );
    }

    if (screen === "settings-capabilities") {
      return (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>Model capabilities</Text>
          <Text color={theme.text.secondary}>Use exact Scout model IDs. Models not listed here remain unverified.</Text>
          <Field
            label="Image-capable models · models that can receive images · default: none"
            value={visionSupportedText}
            placeholder="default: none"
            focused={widgetsActive && accessFocus === 0}
            onChange={(value) => { setVisionSupportedText(value); setFieldError(""); }}
            onSubmit={() => submitSettingField(2)}
          />
          <Field
            label="Image-incompatible models · models that accept text only · default: none"
            value={visionUnsupportedText}
            placeholder="default: none"
            focused={widgetsActive && accessFocus === 1}
            error={accessFocus === 1 ? fieldError : undefined}
            onChange={(value) => { setVisionUnsupportedText(value); setFieldError(""); }}
            onSubmit={() => submitSettingField(2)}
          />
        </Box>
      );
    }

    if (screen === "settings-agent") {
      return (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>Agent behavior</Text>
          <Text color={theme.text.secondary}>Controls how Scout handles one model response.</Text>
          <Field label={`Temperature · response randomness · default: ${initialDraft.agent.temperature}`} value={settingPart(agentText, 0)} placeholder={`default: ${initialDraft.agent.temperature}`} focused={widgetsActive && accessFocus === 0} error={accessFocus === 0 ? fieldError : undefined} onChange={(value) => updateSettingPart(agentText, 0, 4, value, setAgentText)} onSubmit={() => submitSettingField(4)} />
          <Field label={`Max turns · reasoning steps in one response · default: ${initialDraft.agent.maxIterations}`} value={settingPart(agentText, 1)} placeholder={`default: ${initialDraft.agent.maxIterations}`} focused={widgetsActive && accessFocus === 1} error={accessFocus === 1 ? fieldError : undefined} onChange={(value) => updateSettingPart(agentText, 1, 4, value, setAgentText)} onSubmit={() => submitSettingField(4)} />
          <Field label={`Provider retries · retries after a failed model call · default: ${initialDraft.agent.providerMaxRetries}`} value={settingPart(agentText, 2)} placeholder={`default: ${initialDraft.agent.providerMaxRetries}`} focused={widgetsActive && accessFocus === 2} error={accessFocus === 2 ? fieldError : undefined} onChange={(value) => updateSettingPart(agentText, 2, 4, value, setAgentText)} onSubmit={() => submitSettingField(4)} />
          <Field label={`Code timeout · seconds allowed for generated code · default: ${initialDraft.agent.codeTimeout}`} value={settingPart(agentText, 3)} placeholder={`default: ${initialDraft.agent.codeTimeout}`} focused={widgetsActive && accessFocus === 3} error={accessFocus === 3 ? fieldError : undefined} onChange={(value) => updateSettingPart(agentText, 3, 4, value, setAgentText)} onSubmit={() => submitSettingField(4)} />
        </Box>
      );
    }

    if (screen === "settings-capacity") {
      return (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>Server capacity</Text>
          <Text color={theme.text.secondary}>Limits protect the deployment as more people use it.</Text>
          <Field label={`Live sessions · active conversations total · default: ${initialDraft.server.maxLiveSessions}`} value={settingPart(serverText, 0)} placeholder={`default: ${initialDraft.server.maxLiveSessions}`} focused={widgetsActive && accessFocus === 0} error={accessFocus === 0 ? fieldError : undefined} onChange={(value) => updateSettingPart(serverText, 0, 6, value, setServerText)} onSubmit={() => submitSettingField(6)} />
          <Field label={`Live sessions per user · active conversations per person · default: ${initialDraft.server.maxLiveSessionsPerUser}`} value={settingPart(serverText, 1)} placeholder={`default: ${initialDraft.server.maxLiveSessionsPerUser}`} focused={widgetsActive && accessFocus === 1} error={accessFocus === 1 ? fieldError : undefined} onChange={(value) => updateSettingPart(serverText, 1, 6, value, setServerText)} onSubmit={() => submitSettingField(6)} />
          <Field label={`Concurrent requests · requests processed at once · default: ${initialDraft.server.maxConcurrentRequests}`} value={settingPart(serverText, 2)} placeholder={`default: ${initialDraft.server.maxConcurrentRequests}`} focused={widgetsActive && accessFocus === 2} error={accessFocus === 2 ? fieldError : undefined} onChange={(value) => updateSettingPart(serverText, 2, 6, value, setServerText)} onSubmit={() => submitSettingField(6)} />
          <Field label={`Queued requests · waiting requests total · default: ${initialDraft.server.maxQueuedRequests}`} value={settingPart(serverText, 3)} placeholder={`default: ${initialDraft.server.maxQueuedRequests}`} focused={widgetsActive && accessFocus === 3} error={accessFocus === 3 ? fieldError : undefined} onChange={(value) => updateSettingPart(serverText, 3, 6, value, setServerText)} onSubmit={() => submitSettingField(6)} />
          <Field label={`Queued requests per user · waiting requests per person · default: ${initialDraft.server.maxQueuedRequestsPerUser}`} value={settingPart(serverText, 4)} placeholder={`default: ${initialDraft.server.maxQueuedRequestsPerUser}`} focused={widgetsActive && accessFocus === 4} error={accessFocus === 4 ? fieldError : undefined} onChange={(value) => updateSettingPart(serverText, 4, 6, value, setServerText)} onSubmit={() => submitSettingField(6)} />
          <Field label={`Queue timeout · seconds a request may wait · default: ${initialDraft.server.requestQueueTimeoutSeconds}`} value={settingPart(serverText, 5)} placeholder={`default: ${initialDraft.server.requestQueueTimeoutSeconds}`} focused={widgetsActive && accessFocus === 5} error={accessFocus === 5 ? fieldError : undefined} onChange={(value) => updateSettingPart(serverText, 5, 6, value, setServerText)} onSubmit={() => submitSettingField(6)} />
        </Box>
      );
    }

    if (screen === "settings-execution") {
      return (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>Code execution</Text>
          <Text color={theme.text.secondary}>Controls the small sandbox used when Scout runs generated code.</Text>
          <Field label={`Enable code execution · allow generated code to run · default: ${initialDraft.execution.enabled}`} value={settingPart(executionText, 0)} placeholder={`default: ${initialDraft.execution.enabled}`} focused={widgetsActive && accessFocus === 0} error={accessFocus === 0 ? fieldError : undefined} onChange={(value) => updateSettingPart(executionText, 0, 5, value, setExecutionText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Network access · code sandbox policy · default: ${initialDraft.execution.networkDefault}`} value={settingPart(executionText, 1)} placeholder={`default: ${initialDraft.execution.networkDefault}`} focused={widgetsActive && accessFocus === 1} error={accessFocus === 1 ? fieldError : undefined} onChange={(value) => updateSettingPart(executionText, 1, 5, value, setExecutionText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Execution timeout · maximum code runtime in seconds · default: ${initialDraft.execution.timeoutSeconds}`} value={settingPart(executionText, 2)} placeholder={`default: ${initialDraft.execution.timeoutSeconds}`} focused={widgetsActive && accessFocus === 2} error={accessFocus === 2 ? fieldError : undefined} onChange={(value) => updateSettingPart(executionText, 2, 5, value, setExecutionText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Memory limit · maximum sandbox memory in MB · default: ${initialDraft.execution.maxMemoryMb}`} value={settingPart(executionText, 3)} placeholder={`default: ${initialDraft.execution.maxMemoryMb}`} focused={widgetsActive && accessFocus === 3} error={accessFocus === 3 ? fieldError : undefined} onChange={(value) => updateSettingPart(executionText, 3, 5, value, setExecutionText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Process limit · maximum sandbox processes · default: ${initialDraft.execution.maxProcesses}`} value={settingPart(executionText, 4)} placeholder={`default: ${initialDraft.execution.maxProcesses}`} focused={widgetsActive && accessFocus === 4} error={accessFocus === 4 ? fieldError : undefined} onChange={(value) => updateSettingPart(executionText, 4, 5, value, setExecutionText)} onSubmit={() => submitSettingField(5)} />
        </Box>
      );
    }

    if (screen === "settings-multi-agent") {
      return (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>Multi-agent</Text>
          <Text color={theme.text.secondary}>Controls background tasks that can continue working after a response.</Text>
          <Field label={`Enable background agents · allow multi-agent tasks · default: ${initialDraft.multiAgent.enabled}`} value={settingPart(multiAgentText, 0)} placeholder={`default: ${initialDraft.multiAgent.enabled}`} focused={widgetsActive && accessFocus === 0} error={accessFocus === 0 ? fieldError : undefined} onChange={(value) => updateSettingPart(multiAgentText, 0, 5, value, setMultiAgentText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Concurrent background agents · tasks running together · default: ${initialDraft.multiAgent.maxConcurrent}`} value={settingPart(multiAgentText, 1)} placeholder={`default: ${initialDraft.multiAgent.maxConcurrent}`} focused={widgetsActive && accessFocus === 1} error={accessFocus === 1 ? fieldError : undefined} onChange={(value) => updateSettingPart(multiAgentText, 1, 5, value, setMultiAgentText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Max turns · turns allowed per background task · default: ${initialDraft.multiAgent.maxIterations}`} value={settingPart(multiAgentText, 2)} placeholder={`default: ${initialDraft.multiAgent.maxIterations}`} focused={widgetsActive && accessFocus === 2} error={accessFocus === 2 ? fieldError : undefined} onChange={(value) => updateSettingPart(multiAgentText, 2, 5, value, setMultiAgentText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Run in background by default · start eligible tasks automatically · default: ${initialDraft.multiAgent.defaultBackground}`} value={settingPart(multiAgentText, 3)} placeholder={`default: ${initialDraft.multiAgent.defaultBackground}`} focused={widgetsActive && accessFocus === 3} error={accessFocus === 3 ? fieldError : undefined} onChange={(value) => updateSettingPart(multiAgentText, 3, 5, value, setMultiAgentText)} onSubmit={() => submitSettingField(5)} />
          <Field label={`Auto-continue · continue after a task reports completion · default: ${initialDraft.multiAgent.autoContinueOnComplete}`} value={settingPart(multiAgentText, 4)} placeholder={`default: ${initialDraft.multiAgent.autoContinueOnComplete}`} focused={widgetsActive && accessFocus === 4} error={accessFocus === 4 ? fieldError : undefined} onChange={(value) => updateSettingPart(multiAgentText, 4, 5, value, setMultiAgentText)} onSubmit={() => submitSettingField(5)} />
        </Box>
      );
    }

    if (screen === "settings-vllm") {
      return (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>vLLM runtime</Text>
          <Text color={theme.text.secondary}>Only change these when using a custom model or GPU setup.</Text>
          <Field label={`Docker image · vLLM server image · default: ${initialDraft.vllmRuntime.image}`} value={settingPart(vllmRuntimeText, 0)} placeholder={`default: ${initialDraft.vllmRuntime.image}`} focused={widgetsActive && accessFocus === 0} error={accessFocus === 0 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 0, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`GPU memory · fraction reserved for each model · default: ${initialDraft.vllmRuntime.gpuMemoryUtilization}`} value={settingPart(vllmRuntimeText, 1)} placeholder={`default: ${initialDraft.vllmRuntime.gpuMemoryUtilization}`} focused={widgetsActive && accessFocus === 1} error={accessFocus === 1 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 1, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`Context length · maximum tokens; blank lets vLLM choose · default: ${initialDraft.vllmRuntime.maxModelLen || "auto"}`} value={settingPart(vllmRuntimeText, 2)} placeholder={`default: ${initialDraft.vllmRuntime.maxModelLen || "auto"}`} focused={widgetsActive && accessFocus === 2} error={accessFocus === 2 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 2, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`GPUs per model · GPUs used together · default: ${initialDraft.vllmRuntime.tensorParallelSize}`} value={settingPart(vllmRuntimeText, 3)} placeholder={`default: ${initialDraft.vllmRuntime.tensorParallelSize}`} focused={widgetsActive && accessFocus === 3} error={accessFocus === 3 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 3, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`Quantization · optional model compression · default: ${initialDraft.vllmRuntime.quantization || "none"}`} value={settingPart(vllmRuntimeText, 4)} placeholder={`default: ${initialDraft.vllmRuntime.quantization || "none"}`} focused={widgetsActive && accessFocus === 4} error={accessFocus === 4 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 4, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`GPU devices · GPU IDs or all · default: ${initialDraft.vllmRuntime.gpuDevices}`} value={settingPart(vllmRuntimeText, 5)} placeholder={`default: ${initialDraft.vllmRuntime.gpuDevices}`} focused={widgetsActive && accessFocus === 5} error={accessFocus === 5 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 5, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`Tool parser · formats tool calls from the model · default: ${initialDraft.vllmRuntime.toolCallParser}`} value={settingPart(vllmRuntimeText, 6)} placeholder={`default: ${initialDraft.vllmRuntime.toolCallParser}`} focused={widgetsActive && accessFocus === 6} error={accessFocus === 6 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 6, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
          <Field label={`Reasoning parser · extracts reasoning text · default: ${initialDraft.vllmRuntime.reasoningParser}`} value={settingPart(vllmRuntimeText, 7)} placeholder={`default: ${initialDraft.vllmRuntime.reasoningParser}`} focused={widgetsActive && accessFocus === 7} error={accessFocus === 7 ? fieldError : undefined} onChange={(value) => updateSettingPart(vllmRuntimeText, 7, 8, value, setVllmRuntimeText)} onSubmit={() => submitSettingField(8)} />
        </Box>
      );
    }

    if (screen === "mcp") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            MCP integrations <Text color={theme.text.secondary} bold={false}>· optional</Text>
          </Text>
          <Text color={theme.text.secondary}>
            Install remote tools for this deployment. Enter toggles an integration; d removes it.
          </Text>
          <SelectList
            key={`mcp-${generation}-${draft.mcpServers.map((server) => `${server.id}:${server.enabled}`).join(",")}`}
            options={[
              ...draft.mcpServers.map((server) => ({
                label: server.name,
                detail: server.url ?? server.image,
                badge: server.enabled ? "enabled" : "disabled",
              })),
              { label: "Add remote MCP server…", detail: "Streamable HTTP" },
              { label: "Add container MCP server…", detail: "isolated stdio · advanced" },
              { label: "Continue to review", detail: `${draft.mcpServers.filter((server) => server.enabled).length} enabled` },
            ]}
            onSubmit={submitMcp}
            onMark={removeMcp}
            onBack={goBack}
            onUp={focusBar}
            isActive={widgetsActive}
          />
        </Box>
      );
    }

    if (screen.startsWith("mcp-add")) {
      const isContainer = screen === "mcp-add-container";
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>Add {isContainer ? "container" : "remote"} MCP server</Text>
          <Field
            label="Integration name"
            value={mcpName}
            placeholder="e.g. Linear"
            focused={widgetsActive && mcpFocus === 0}
            error={mcpFocus === 0 ? fieldError : undefined}
            onChange={(value) => { setMcpName(value); setFieldError(""); }}
            onSubmit={addMcp}
          />
          {isContainer ? (
            <>
              <Field
                label="Container image — digest pin required"
                value={mcpImage}
                placeholder="ghcr.io/example/server@sha256:…"
                focused={widgetsActive && mcpFocus === 1}
                error={mcpFocus === 1 ? fieldError : undefined}
                onChange={(value) => { setMcpImage(value); setFieldError(""); }}
                onSubmit={addMcp}
              />
              <Field
                label="Command and arguments — optional"
                value={mcpCommand}
                placeholder="node /app/server.js"
                focused={widgetsActive && mcpFocus === 2}
                error={mcpFocus === 2 ? fieldError : undefined}
                onChange={(value) => { setMcpCommand(value); setFieldError(""); }}
                onSubmit={addMcp}
              />
            </>
          ) : (
            <Field
              label="Streamable HTTP URL"
              value={mcpUrl}
              placeholder="https://example.com/mcp"
              focused={widgetsActive && mcpFocus === 1}
              error={mcpFocus === 1 ? fieldError : undefined}
              onChange={(value) => { setMcpUrl(value); setFieldError(""); }}
              onSubmit={addMcp}
            />
          )}
          <Text color={theme.text.secondary}>
            {isContainer
              ? "Runs without network, caps, or root; mounts that user's workspace only."
              : "Authentication is configured after launch in Admin → Tools or by each user in Settings → Integrations."}
          </Text>
        </Box>
      );
    }

    // review
    const summary: [string, string][] = [
      ...enabled.map((id): [string, string] => [META[id].label, draft.providers[id].models.map((model) => modelId(id, model)).join(", ")]),
      ["Default model", draft.defaultModel || "—"],
      ["Scout URL", `http://localhost:${draft.port}`],
      ["Bind address", draft.bindAddress],
      ["Admin users", draft.adminUsers || "first registered user"],
      ["Workspace", `${draft.workspaceRoot} — users/ + shared/, owned by UID 1000`],
      ["Server data", draft.dataDir || "Docker volume (scout-data)"],
      ["Agent", `${draft.agent.temperature} temperature · ${draft.agent.maxIterations} iterations · ${draft.agent.providerMaxRetries} retries`],
      ["Capacity", `${draft.server.maxConcurrentRequests} concurrent · ${draft.server.maxLiveSessions} sessions · ${draft.server.maxQueuedRequests} queued`],
      ["Execution", `${draft.execution.enabled ? "enabled" : "disabled"} · ${draft.execution.networkDefault} network · ${draft.execution.maxMemoryMb} MB`],
      ["Multi-agent", `${draft.multiAgent.enabled ? "enabled" : "disabled"} · ${draft.multiAgent.maxConcurrent} concurrent · ${draft.multiAgent.maxIterations} iterations`],
      ["vLLM", draft.providers.vllm.apiBase || `${draft.providers.vllm.models.length} managed service(s)`],
      ["MCP tools", draft.mcpServers.length ? `${draft.mcpServers.filter((server) => server.enabled).length} enabled` : "none"],
      ["Draft", draftPath],
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary} bold>
          Ready to apply
        </Text>
        <Box flexDirection="column">
          {summary.map(([label, value]) => (
            <Box key={label}>
              <Box width={16}>
                <Text color={theme.text.secondary}>{label}</Text>
              </Box>
              <Text color={theme.text.primary}>{value}</Text>
            </Box>
          ))}
        </Box>
        <CardRow
          key={`review-${generation}`}
          options={[
            { label: "Apply & launch", blurb: "Write .env + config, then docker compose up --build --detach." },
            { label: "Save draft & exit", blurb: "Nothing is written yet — resume with scout deploy --resume." },
          ]}
          onSubmit={(index) => {
            const next = { ...draft, adminUsers: adminText.trim(), port: Number(portText) || draft.port };
            if (index === 0) finish("apply", next);
            else {
              onPersist(next);
              finish("save", next);
            }
          }}
          onBack={goBack}
          onUp={focusBar}
          isActive={widgetsActive}
        />
      </Box>
    );
  })();

  const stepHints: KeyHint[] = [
    { keys: "↑", label: "steps" },
    { keys: "ctrl+n/p", label: "next/prev" },
  ];
  const hints: KeyHint[] = !dockerOk
    ? [{ keys: "ctrl+c", label: "quit" }]
    : barFocus
      ? [
          { keys: "←/→", label: "step" },
          { keys: "↵", label: "open" },
          { keys: "↓/esc", label: "back" },
        ]
      : onFieldScreen
        ? [
            { keys: "↵", label: "continue" },
            ...(screen.startsWith("settings-") || screen.startsWith("mcp-add") || screen.startsWith("model:") ? [{ keys: "↑/↓", label: "field" }] : []),
            ...stepHints,
            { keys: "esc", label: "back" },
          ]
        : [
            ...(screen === "providers"
              ? [
                  { keys: "←/→", label: "move" },
                  { keys: "space", label: "toggle" },
                  { keys: "↵", label: "open" },
                ]
              : [
                  { keys: screen.startsWith("menu:") || screen === "review" ? "←/→" : "↑/↓", label: "select" },
                  { keys: "↵", label: "confirm" },
                  ...(screen === "mcp" ? [{ keys: "d", label: "remove" }] : []),
                  ...(screen.startsWith("model:") ? [{ keys: "d", label: "set default" }] : []),
                ]),
            ...stepHints,
            { keys: "esc", label: screen === "providers" ? "quit" : "back" },
            { keys: "r", label: "start over" },
          ];

  const compactChecks = (
    <Text>
      <Text color={theme.text.secondary}>docker </Text>
      <Text color={dockerOk ? theme.status.success : theme.status.error}>{dockerOk ? "✓" : "✗"}</Text>
      <Text color={theme.text.secondary}>  gpu </Text>
      <Text color={checks.gpu && checks.nvidiaRuntime ? theme.status.success : theme.brand.frame}>
        {checks.gpu && checks.nvidiaRuntime ? "✓" : "✗"}
      </Text>
    </Text>
  );

  return (
    <Box flexDirection="column" width={columns} minHeight={rows}>
      <Box paddingX={2} paddingTop={1} justifyContent="space-between">
        <Text>
          <Text color={theme.text.accent} bold>
            ✦
          </Text>
          <Text color={theme.text.primary} bold>
            {" "}
            Scout Deploy
          </Text>
        </Text>
        <Text color={theme.text.secondary}>{SOURCE_NOTE[source]}</Text>
      </Box>
      <Box paddingX={2} marginTop={1} justifyContent="space-between">
        <StepTrail steps={STEPS} current={step} reachable={reachable} focused={barFocus} cursor={barCursor} />
        {compactChecks}
      </Box>
      <Box
        borderStyle="single"
        borderColor={theme.brand.frame}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        marginTop={1}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        flexGrow={1}
      >
        {body}
        {warning && screen !== "providers" && !screen.startsWith("menu:") && (
          <Box marginTop={1}>
            <Text color={theme.status.warning}>{warning}</Text>
          </Box>
        )}
      </Box>
      <Box
        borderStyle="single"
        borderColor={theme.brand.frame}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        paddingX={2}
      >
        <KeyHints hints={hints} />
      </Box>
    </Box>
  );
};
