import { useState, useEffect, useCallback } from "react";

interface UseConfigReturn {
  models: string[];
  currentModel: string;
  setModel: (model: string) => Promise<void>;
  reloadConfig: () => Promise<void>;
}

export function useConfig(baseUrl: string, isReady: boolean, token: string | null): UseConfigReturn {
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState("");

  const fetchConfig = useCallback(async () => {
    if (!isReady) return;
    try {
      const [cfgResp, modelsResp] = await Promise.all([
        fetch(`${baseUrl}/config`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
        fetch(`${baseUrl}/config/models`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
      ]);
      const cfg = await cfgResp.json();
      const modelsBody = await modelsResp.json();
      setCurrentModel(cfg?.agent?.model ?? "");
      setModels(modelsBody?.models ?? []);
    } catch {
      // best-effort
    }
  }, [baseUrl, isReady]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const setModel = useCallback(
    async (model: string) => {
      setCurrentModel(model);
      await fetch(`${baseUrl}/config`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          key: "agent.model",
          value: model,
          scope: "global",
        }),
      }).catch(() => {});
      await fetch(`${baseUrl}/config/reload`, { 
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }).catch(() => {});
    },
    [baseUrl],
  );

  const reloadConfig = useCallback(async () => {
    await fetch(`${baseUrl}/config/reload`, { 
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
    await fetchConfig();
  }, [baseUrl, fetchConfig]);

  return { models, currentModel, setModel, reloadConfig };
}
