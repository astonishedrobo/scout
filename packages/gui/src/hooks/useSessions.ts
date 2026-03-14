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

export function useSessions(baseUrl: string, isReady: boolean, token: string | null, isMultiUser: boolean | undefined): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval>>();

  const refreshSessions = useCallback(async () => {
    if (!baseUrl || isMultiUser === false) return;
    try {
      const resp = await fetch(`${baseUrl}/sessions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (resp.ok) {
        const data = await resp.json();
        setSessions(data.sessions ?? []);
      } else if (resp.status === 401) {
        console.warn("Sessions fetch failed: Unauthorized");
      }
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    }
  }, [baseUrl, token, isMultiUser]);

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
      
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({ detail: "Unknown error" }));
        throw new Error(errorData.detail || "Failed to create session");
      }

      const data = await resp.json();
      const id = data.sessionId as string;
      if (!id) throw new Error("Server did not return a session ID");
      
      setCurrentSessionId(id);
      await refreshSessions();
      return id;
    },
    [baseUrl, token, refreshSessions],
  );

  const loadSession = useCallback(
    async (id: string) => {
      const resp = await fetch(`${baseUrl}/sessions/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({ detail: "Session not found" }));
        throw new Error(errorData.detail || "Failed to load session");
      }
      const data = await resp.json();
      setCurrentSessionId(id);
      return data.messages as { role: string; content: string; steps?: any[] }[];
    },
    [baseUrl, token],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      const resp = await fetch(`${baseUrl}/sessions/${id}`, { 
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (resp.ok) {
        if (currentSessionId === id) setCurrentSessionId(null);
        await refreshSessions();
      } else {
        const errorData = await resp.json().catch(() => ({ detail: "Delete failed" }));
        throw new Error(errorData.detail || "Failed to delete session");
      }
    },
    [baseUrl, currentSessionId, refreshSessions, token],
  );

  const appendMessage = useCallback(
    async (
      sessionId: string,
      role: string,
      content: string,
      extra?: { steps?: any[]; model?: string; attachments?: string[] },
    ) => {
      const resp = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ role, content, ...extra }),
      });
      
      if (!resp.ok) {
        console.error("Failed to append message:", await resp.text().catch(() => "Unknown error"));
      }

      // Refresh to pick up updated title/timestamp
      await refreshSessions();
    },
    [baseUrl, refreshSessions, token],
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
