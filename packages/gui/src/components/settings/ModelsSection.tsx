import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  IconButton,
  Input,
  PasswordInput,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "../ui";
import { useAuthHeaders, useConfigWriter, type SectionProps } from "./shared";

interface ProviderState {
  name: string;
  api_key: string;
  api_base: string;
  models: string[];
}

interface DesktopEnvOption {
  label: string;
  value: string;
  type: "venv" | "conda" | "system";
}

const EMPTY_PROVIDER: ProviderState = { name: "", api_key: "", api_base: "", models: [] };

/**
 * Providers and agent tuning — single-user only, because these write global
 * config and `POST /config` is 403 in server mode.
 */
export function ModelsSection(props: SectionProps) {
  const { baseUrl, token, setStatus } = props;
  const authHeaders = useAuthHeaders(token);
  const writeConfig = useConfigWriter(props);

  const [providers, setProviders] = useState<ProviderState[]>([EMPTY_PROVIDER]);
  const [agentModel, setAgentModel] = useState("");
  const [temperature, setTemperature] = useState(0.2);
  const [maxIterations, setMaxIterations] = useState(15);
  const [codeTimeout, setCodeTimeout] = useState(30);
  const [savingProviders, setSavingProviders] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);

  const [desktopEnvs, setDesktopEnvs] = useState<DesktopEnvOption[]>([]);
  const [selectedEnv, setSelectedEnv] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`${baseUrl}/config`, { headers: authHeaders })
      .then((r) => r.json())
      .then((cfg) => {
        if (cancelled) return;
        setAgentModel(cfg?.agent?.model ?? "");
        setTemperature(cfg?.agent?.temperature ?? 0.2);
        setMaxIterations(cfg?.agent?.max_iterations ?? 15);
        setCodeTimeout(cfg?.agent?.code_timeout ?? 30);
        const entries = Object.entries<Record<string, unknown>>(cfg?.llm?.providers ?? {});
        const list = entries.map(([name, p]) => ({
          name,
          api_key: (p.api_key as string) ?? "",
          api_base: (p.api_base as string) ?? "",
          models: (p.models as string[]) ?? [],
        }));
        setProviders(list.length ? list : [EMPTY_PROVIDER]);
      })
      .catch(() => setStatus({ message: "Could not load configuration.", tone: "error" }));
    return () => {
      cancelled = true;
    };
  }, [baseUrl, authHeaders, setStatus]);

  useEffect(() => {
    if (!window.scoutDesktop) return;
    let cancelled = false;
    (async () => {
      try {
        const [envs, current] = await Promise.all([
          window.scoutDesktop!.listPythonEnvs(),
          window.scoutDesktop!.getSelectedPythonEnv(),
        ]);
        if (cancelled) return;
        setDesktopEnvs(envs);
        setSelectedEnv(
          current.pythonPath
            ? `venv:${current.pythonPath}`
            : current.condaEnv
              ? `conda:${current.condaEnv}`
              : "system:system",
        );
      } catch {
        if (!cancelled) {
          setStatus({ message: "Could not load Python environments.", tone: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setStatus]);

  const patchProvider = (index: number, patch: Partial<ProviderState>) =>
    setProviders((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  const saveProviders = async () => {
    setSavingProviders(true);
    const payload: Record<string, unknown> = {};
    for (const p of providers) {
      if (!p.name.trim()) continue;
      payload[p.name.trim()] = {
        api_key: p.api_key,
        ...(p.api_base ? { api_base: p.api_base } : {}),
        models: p.models.filter((m) => m.trim()),
      };
    }
    await writeConfig({ "llm.providers": payload }, "Providers saved.");
    setSavingProviders(false);
  };

  const saveAgent = async () => {
    setSavingAgent(true);
    await writeConfig(
      {
        "agent.model": agentModel,
        "agent.temperature": temperature,
        "agent.max_iterations": maxIterations,
        "agent.code_timeout": codeTimeout,
      },
      "Agent settings saved.",
    );
    setSavingAgent(false);
  };

  const selectEnv = async (value: string) => {
    setSelectedEnv(value);
    if (!window.scoutDesktop) return;
    const split = value.indexOf(":");
    const res = await window.scoutDesktop.selectPythonEnv({
      type: value.slice(0, split) as DesktopEnvOption["type"],
      value: value.slice(split + 1),
    });
    setStatus({ message: res.message, tone: "info" });
  };

  return (
    <>
      {window.scoutDesktop && (
        <SettingsGroup label="Python runtime" description="Used by `run_code` in this workspace.">
          <SettingsRow
            label="Environment"
            description="Applies to new runs."
            control={
              <SettingsSelect
                value={selectedEnv}
                onChange={selectEnv}
                label="Python environment"
                options={desktopEnvs.map((env) => ({
                  value: `${env.type}:${env.value}`,
                  label: env.label,
                }))}
              />
            }
          />
        </SettingsGroup>
      )}

      <SettingsGroup
        label="Providers"
        description="API keys and model lists, per provider."
        action={
          <Button
            variant="ghost"
            surface="panel"
            size="compact"
            onClick={saveProviders}
            loading={savingProviders}
          >
            Save
          </Button>
        }
      >
        {providers.map((provider, index) => (
          <SettingsRow
            key={index}
            label={provider.name.trim() || "New provider"}
            description="Name, key, and the models it serves."
            control={
              providers.length > 1 ? (
                <IconButton
                  label={`Remove ${provider.name.trim() || "provider"}`}
                  tone="danger"
                  onClick={() => setProviders((list) => list.filter((_, i) => i !== index))}
                >
                  <Trash2 size={15} />
                </IconButton>
              ) : undefined
            }
          >
            <div className="mt-3 space-y-2">
              <Input
                size="sm"
                aria-label="Provider name"
                value={provider.name}
                onChange={(e) => patchProvider(index, { name: e.target.value })}
                placeholder="groq, openai, anthropic…"
              />
              <PasswordInput
                size="sm"
                aria-label={`API key for ${provider.name.trim() || "provider"}`}
                value={provider.api_key}
                onChange={(e) => patchProvider(index, { api_key: e.target.value })}
                placeholder="sk-…"
                className="font-mono"
              />
              <Input
                size="sm"
                aria-label="Models, comma separated"
                value={provider.models.join(", ")}
                onChange={(e) =>
                  patchProvider(index, { models: e.target.value.split(",").map((m) => m.trim()) })
                }
                placeholder="groq/llama-3.1-8b-instant, openai/gpt-4o"
              />
            </div>
          </SettingsRow>
        ))}
        <SettingsRow
          label="Add a provider"
          control={
            <Button
              variant="outlined"
              surface="panel"
              size="compact"
              onClick={() => setProviders((list) => [...list, EMPTY_PROVIDER])}
            >
              <Plus size={13} />
              Add
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        label="Agent"
        description="How the agent behaves by default."
        action={
          <Button
            variant="ghost"
            surface="panel"
            size="compact"
            onClick={saveAgent}
            loading={savingAgent}
          >
            Save
          </Button>
        }
      >
        <SettingsRow label="Default model" description="Used when a conversation does not pick one.">
          <Input
            size="sm"
            aria-label="Default model"
            value={agentModel}
            onChange={(e) => setAgentModel(e.target.value)}
            placeholder="groq/llama-3.1-8b-instant"
            className="mt-3"
          />
        </SettingsRow>
        <SettingsRow
          label="Temperature"
          description="Lower is more deterministic."
          control={<Badge>{temperature}</Badge>}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={temperature}
            aria-label="Temperature"
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="mt-3 h-1.5 w-full accent-scout-text"
          />
        </SettingsRow>
        <SettingsRow
          label="Max iterations"
          description="Tool calls allowed in a single turn."
          control={
            <Input
              size="sm"
              type="number"
              min={1}
              aria-label="Max iterations"
              value={maxIterations}
              // Empty is not silently 15: the old field reset to a default the
              // moment you cleared it, so you could not type "20" over "15".
              onChange={(e) => setMaxIterations(e.target.value === "" ? 0 : Number(e.target.value))}
              className="w-20"
            />
          }
        />
        <SettingsRow
          label="Code timeout"
          description="Seconds before `run_code` is cut off."
          control={
            <Input
              size="sm"
              type="number"
              min={1}
              aria-label="Code timeout in seconds"
              value={codeTimeout}
              onChange={(e) => setCodeTimeout(e.target.value === "" ? 0 : Number(e.target.value))}
              className="w-20"
            />
          }
        />
      </SettingsGroup>
    </>
  );
}
