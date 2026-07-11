/**
 * Scout deploy wizard — single-screen Ink app.
 *
 * Steps: Providers → Default model → Access → Review. Each provider on
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
import { modelId, PROVIDER_IDS, type DeploymentDraft, type ProviderId } from "../deploy.js";
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

const STEPS = ["Providers", "Settings", "Review"];
const SETTINGS_FIELDS = 4;

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
  const [keyText, setKeyText] = useState("");
  const [adminText, setAdminText] = useState(initialDraft.adminUsers);
  const [portText, setPortText] = useState(String(initialDraft.port));
  const [workspaceText, setWorkspaceText] = useState(initialDraft.workspaceRoot);
  const [dataText, setDataText] = useState(initialDraft.dataDir);
  const [accessFocus, setAccessFocus] = useState(0);
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

  const providerDone = (id: ProviderId) => !!draft.providers[id].model && (id === "vllm" || !!draft.providers[id].apiKey);
  const configComplete = enabled.length > 0 && enabled.every(providerDone);
  const configuredCount = enabled.filter(providerDone).length;
  // With several providers the default must be an explicit choice (d key).
  const defaultExplicit = enabled.some((id) => providerDone(id) && modelId(id, draft.providers[id].model) === draft.defaultModel);
  const reviewReady = configComplete && (configuredCount < 2 || defaultExplicit);

  const step = screen === "access" ? 1 : screen === "review" ? 2 : 0;
  const reachable = [true, true, reviewReady];

  const onFieldScreen = screen.startsWith("key:") || screen === "access" || (screen.startsWith("model:") && customModel);

  const modelOptions = useMemo(() => {
    if (!meta || !currentProvider) return [];
    const current = draft.providers[currentProvider].model;
    const known = meta.models.some((m) => m.value === current);
    return known || !current ? meta.models : [{ label: current, value: current, detail: "current" }, ...meta.models];
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
      setCustomModel(!META[id].models.some((m) => m.value) && !from.providers[id].model);
      setModelText(from.providers[id].model);
    }
    if (target.startsWith("key:")) setKeyText(from.providers[target.split(":")[1] as ProviderId].apiKey);
    if (target === "access") setAccessFocus(0);
    setScreen(target);
  };

  const goBack = () => {
    if (screen.startsWith("model:") && customModel && META[currentProvider!].models.some((m) => m.value))
      return setCustomModel(false);
    if (screen.startsWith("model:") || screen.startsWith("key:")) return enterScreen(`menu:${currentProvider}`);
    if (screen.startsWith("menu:")) return enterScreen("providers");
    if (screen === "access") return enterScreen("providers");
    if (screen === "review") return enterScreen("access");
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
    const next = { ...draft };
    // Single configured provider: its model is the default, no d needed.
    if (!defaultExplicit) {
      const only = enabled.filter(providerDone)[0]!;
      next.defaultModel = modelId(only, next.providers[only].model);
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
    if (key.ctrl && input === "n") return jumpTo(Math.min(step + 1, 2));
    if (key.ctrl && input === "p") return jumpTo(Math.max(step - 1, 0));
    if (barFocus) {
      if (key.leftArrow) return setBarCursor((prev) => (prev + STEPS.length - 1) % STEPS.length);
      if (key.rightArrow || key.tab) return setBarCursor((prev) => (prev + 1) % STEPS.length);
      if (key.return) return jumpTo(barCursor);
      if (key.downArrow || key.escape) return setBarFocus(false);
      return;
    }
    if (screen === "access") {
      if (key.upArrow) {
        setFieldError("");
        return accessFocus === 0 ? focusBar() : setAccessFocus(accessFocus - 1);
      }
      if (key.downArrow) {
        setFieldError("");
        return setAccessFocus(Math.min(SETTINGS_FIELDS - 1, accessFocus + 1));
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
    // Opening a provider's menu enables it — configuring implies intent.
    if (!enabled.includes(id)) persist({ ...draft, enabled: PROVIDER_IDS.filter((p) => enabled.includes(p) || p === id) });
    enterScreen(`menu:${id}`);
  };

  const submitMenu = (index: number) => {
    const id = currentProvider!;
    if (index === 0) return enterScreen(`model:${id}`);
    if (id !== "vllm" && index === 1) return enterScreen(`key:${id}`);
    enterScreen("providers");
  };

  const applyModel = (value: string, asDefault = false) => {
    const id = currentProvider!;
    setCustomModel(false);
    const next = {
      ...draft,
      providers: { ...draft.providers, [id]: { ...draft.providers[id], model: value } },
      ...(asDefault ? { defaultModel: modelId(id, value) } : {}),
    };
    persist(next);
    enterScreen(`menu:${id}`, next);
  };

  const submitModel = (index: number, asDefault = false) => {
    const option = modelOptions[index]!;
    if (!option.value) {
      setModelText(draft.providers[currentProvider!].model);
      setCustomModel(true);
      return;
    }
    applyModel(option.value, asDefault);
  };

  const submitCustomModel = () => {
    let value = modelText.trim();
    if (!value) return setFieldError("Enter a model ID, or press Esc to go back.");
    // API providers need their litellm prefix; add it when the user typed
    // the bare model name. vLLM keeps the raw Hugging Face repo ID — the
    // hosted_vllm/ prefix is applied by modelId() when writing config.
    const id = currentProvider!;
    if (id !== "vllm" && !value.startsWith(`${id}/`)) value = `${id}/${value}`;
    applyModel(value);
  };

  const submitKey = () => {
    const value = keyText.trim();
    if (!value) return setFieldError(`${meta!.keyLabel} is required for ${meta!.label}.`);
    const id = currentProvider!;
    const next = { ...draft, providers: { ...draft.providers, [id]: { ...draft.providers[id], apiKey: value } } };
    persist(next);
    enterScreen(`menu:${id}`, next);
  };

  const submitAccess = () => {
    if (accessFocus < SETTINGS_FIELDS - 1) return setAccessFocus(accessFocus + 1);
    if (!/^\d+$/.test(portText.trim()) || Number(portText) < 1 || Number(portText) > 65535) {
      setAccessFocus(1);
      return setFieldError("Port must be a number between 1 and 65535.");
    }
    if (!workspaceText.trim()) {
      setAccessFocus(2);
      return setFieldError("Workspace location is required — ./workspace keeps the current behavior.");
    }
    const next = {
      ...draft,
      adminUsers: adminText.trim(),
      port: Number(portText),
      workspaceRoot: workspaceText.trim(),
      dataDir: dataText.trim(),
    };
    if (!configComplete) {
      persist(next);
      enterScreen("providers", next);
      setWarning("Finish configuring your enabled providers to reach Review.");
      return;
    }
    if (!next.defaultModel || !enabled.some((id) => modelId(id, next.providers[id].model) === next.defaultModel)) {
      const first = enabled.filter(providerDone)[0]!;
      next.defaultModel = modelId(first, next.providers[first].model);
    }
    persist(next);
    enterScreen("review", next);
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
        { label: "Model", blurb: config.model || "not set" },
        ...(meta.id === "vllm" ? [] : [{ label: "API key", blurb: config.apiKey ? "••• set" : "not set" }]),
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
            checked={[!!config.model, ...(meta.id === "vllm" ? [] : [!!config.apiKey])]}
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
          {customModel ? (
            <Box flexDirection="column" gap={1}>
              <Field
                label={meta.id === "vllm" ? "Hugging Face model ID" : "Model ID"}
                value={modelText}
                placeholder={`e.g. ${meta.example}`}
                focused={widgetsActive}
                error={fieldError}
                onChange={(value) => {
                  setModelText(value);
                  setFieldError("");
                }}
                onSubmit={submitCustomModel}
              />
              <Text color={theme.text.secondary}>{meta.idHint}</Text>
            </Box>
          ) : (
            <SelectList
              key={`${screen}-${generation}`}
              options={modelOptions.map((m) => ({
                label: m.label,
                detail: m.detail,
                badge: m.value && modelId(meta.id, m.value) === draft.defaultModel ? "✓ default" : undefined,
              }))}
              initialIndex={Math.max(0, modelOptions.findIndex((m) => m.value === draft.providers[meta.id].model))}
              onSubmit={submitModel}
              onMark={(index) => submitModel(index, true)}
              onBack={goBack}
              onUp={focusBar}
              isActive={widgetsActive}
            />
          )}
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

    if (screen === "access") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.primary} bold>
            Deployment settings
          </Text>
          <Field
            label="Admin usernames — comma-separated, optional"
            value={adminText}
            placeholder="defaults to the first registered user"
            focused={widgetsActive && accessFocus === 0}
            onChange={setAdminText}
            onSubmit={submitAccess}
          />
          <Field
            label="Public Scout port"
            value={portText}
            placeholder="4200"
            focused={widgetsActive && accessFocus === 1}
            error={accessFocus === 1 ? fieldError : undefined}
            onChange={(value) => {
              setPortText(value);
              setFieldError("");
            }}
            onSubmit={submitAccess}
          />
          <Field
            label="Workspace location — users/ + shared/ live here"
            value={workspaceText}
            placeholder="./workspace"
            focused={widgetsActive && accessFocus === 2}
            error={accessFocus === 2 ? fieldError : undefined}
            onChange={(value) => {
              setWorkspaceText(value);
              setFieldError("");
            }}
            onSubmit={submitAccess}
          />
          <Field
            label="Server data (DB, sessions) — blank = default Docker volume; set a path to make it a browsable host folder"
            value={dataText}
            placeholder="default: scout-data volume"
            focused={widgetsActive && accessFocus === 3}
            onChange={setDataText}
            onSubmit={submitAccess}
          />
        </Box>
      );
    }

    // review
    const summary: [string, string][] = [
      ...enabled.map((id): [string, string] => [META[id].label, modelId(id, draft.providers[id].model)]),
      ["Default model", draft.defaultModel || "—"],
      ["Scout URL", `http://localhost:${draft.port}`],
      ["Admin users", draft.adminUsers || "first registered user"],
      ["Workspace", `${draft.workspaceRoot} — users/ + shared/, owned by UID 1000`],
      ["Server data", draft.dataDir || "Docker volume (scout-data)"],
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
            ...(screen === "access" ? [{ keys: "↑/↓", label: "field" }] : []),
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
