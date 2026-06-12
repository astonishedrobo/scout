import { useState, useEffect, useCallback } from "react";

interface UseConfigReturn {
  models: string[];
  currentModel: string;
  setModel: (model: string, sessionId?: string | null) => Promise<void>;
  reloadConfig: () => Promise<void>;
  capabilities: Record<string, { vision: "supported" | "unsupported" | "unverified" }>;
}

export function useConfig(baseUrl: string, isReady: boolean, token: string | null): UseConfigReturn {
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [capabilities, setCapabilities] = useState<UseConfigReturn["capabilities"]>({});

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
      setCapabilities(modelsBody?.capabilities ?? {});
    } catch {
      // best-effort
    }
  }, [baseUrl, isReady]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const setModel = useCallback(
    async (model: string, sessionId?: string | null) => {
      if (!sessionId) throw new Error("Start a conversation before switching models.");
      const resp = await fetch(`${baseUrl}/sessions/${sessionId}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.detail?.message ?? body?.detail ?? "Could not switch model.");
      }
      const body = await resp.json();
      setCurrentModel(body.model);
    },
    [baseUrl, token],
  );

  const reloadConfig = useCallback(async () => {
    await fetch(`${baseUrl}/config/reload`, { 
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
    await fetchConfig();
  }, [baseUrl, fetchConfig]);

  return { models, currentModel, setModel, reloadConfig, capabilities };
}
