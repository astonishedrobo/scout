import { useState, useCallback, useEffect, useRef } from "react";

export interface SessionMeta {
  sessionId: string;
  projectDir: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
}

interface UseSessionsReturn {
  sessions: SessionMeta[];
  currentSessionId: string | null;
  createSession: (model?: string) => Promise<string>;
  loadSession: (id: string) => Promise<{ role: string; content: string; steps?: any[] }[]>;
  deleteSession: (id: string) => Promise<void>;
  appendMessage: (
    sessionId: string,
    role: string,
    content: string,
    extra?: { steps?: any[]; model?: string; attachments?: string[] },
  ) => Promise<void>;
  setCurrentSessionId: (id: string | null) => void;
  refreshSessions: () => Promise<void>;
}

export function useSessions(baseUrl: string, isReady: boolean, token: string | null): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval>>();

  const refreshSessions = useCallback(async () => {
    if (!baseUrl) return;
    try {
      const resp = await fetch(`${baseUrl}/sessions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (resp.ok) {
        const data = await resp.json();
        setSessions(data.sessions ?? []);
      }
    } catch {
      // ignore
    }
  }, [baseUrl]);

  useEffect(() => {
    if (isReady) {
      refreshSessions();
      refreshTimerRef.current = setInterval(refreshSessions, 10_000);
    }
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [isReady, refreshSessions]);

  const createSession = useCallback(
    async (model?: string): Promise<string> => {
      const resp = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ model }),
      });
      const data = await resp.json();
      const id = data.sessionId as string;
      setCurrentSessionId(id);
      await refreshSessions();
      return id;
    },
    [baseUrl, refreshSessions],
  );

  const loadSession = useCallback(
    async (id: string) => {
      const resp = await fetch(`${baseUrl}/sessions/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) throw new Error("Failed to load session");
      const data = await resp.json();
      setCurrentSessionId(id);
      return data.messages as { role: string; content: string; steps?: any[] }[];
    },
    [baseUrl],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`${baseUrl}/sessions/${id}`, { 
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (currentSessionId === id) setCurrentSessionId(null);
      await refreshSessions();
    },
    [baseUrl, currentSessionId, refreshSessions],
  );

  const appendMessage = useCallback(
    async (
      sessionId: string,
      role: string,
      content: string,
      extra?: { steps?: any[]; model?: string; attachments?: string[] },
    ) => {
      await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ role, content, ...extra }),
      }).catch(() => {});
      // Refresh to pick up updated title/timestamp
      await refreshSessions();
    },
    [baseUrl, refreshSessions],
  );

  return {
    sessions,
    currentSessionId,
    createSession,
    loadSession,
    deleteSession,
    appendMessage,
    setCurrentSessionId,
    refreshSessions,
  };
}
