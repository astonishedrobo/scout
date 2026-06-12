import { useState, useCallback, useEffect, useRef } from "react";
import type { Artifact, ChatImage, ToolStep } from "scout-core";

interface StoredMessage {
  role: string;
  content: string;
  steps?: ToolStep[];
  artifacts?: Artifact[];
  attachments?: string[];
  chatImages?: ChatImage[];
}

export interface SessionMeta {
  sessionId: string;
  projectDir: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  parentSessionId?: string | null;
  forkPointIndex?: number | null;
}

interface UseSessionsReturn {
  sessions: SessionMeta[];
  currentSessionId: string | null;
  createSession: (model?: string) => Promise<string>;
  loadSession: (id: string) => Promise<StoredMessage[]>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  appendMessage: (
    sessionId: string,
    role: string,
    content: string,
    extra?: { steps?: any[]; model?: string; attachments?: string[]; artifacts?: any[]; chat_images?: any[] },
  ) => Promise<void>;
  setCurrentSessionId: (id: string | null) => void;
  refreshSessions: () => Promise<void>;
  forkSession: (sessionId: string, fromMessageIndex: number) => Promise<string>;
}

export function useSessions(baseUrl: string, isReady: boolean, token: string | null, isMultiUser: boolean | undefined, onUnauthorized?: () => void): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval>>();

  const handleResponse = useCallback((resp: Response) => {
    if (resp.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    return resp;
  }, [onUnauthorized]);

  const refreshSessions = useCallback(async () => {
    if (!baseUrl || (isMultiUser && !token)) return;
    try {
      const resp = handleResponse(await fetch(`${baseUrl}/sessions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }));
      if (resp.ok) {
        const data = await resp.json();
        setSessions(data.sessions ?? []);
      } else if (resp.status === 401) {
        console.warn("Sessions fetch failed: Unauthorized — clearing stale token");
      }
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    }
  }, [baseUrl, token, isMultiUser, handleResponse]);

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
      return data.messages as StoredMessage[];
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

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const resp = await fetch(`${baseUrl}/sessions/${id}/title`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ title }),
      });
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({ detail: "Rename failed" }));
        throw new Error(errorData.detail || "Failed to rename session");
      }
      await refreshSessions();
    },
    [baseUrl, refreshSessions, token],
  );

  const appendMessage = useCallback(
    async (
      sessionId: string,
      role: string,
      content: string,
      extra?: { steps?: any[]; model?: string; attachments?: string[]; artifacts?: any[]; chat_images?: any[] },
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

  const forkSession = useCallback(
    async (sessionId: string, fromMessageIndex: number): Promise<string> => {
      const resp = await fetch(`${baseUrl}/sessions/${sessionId}/fork`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ from_message_index: fromMessageIndex }),
      });
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({ detail: "Fork failed" }));
        throw new Error(errorData.detail || "Failed to fork session");
      }
      const data = await resp.json();
      const id = data.sessionId as string;
      setCurrentSessionId(id);
      await refreshSessions();
      return id;
    },
    [baseUrl, token, refreshSessions],
  );

  return {
    sessions,
    currentSessionId,
    createSession,
    loadSession,
    renameSession,
    deleteSession,
    appendMessage,
    setCurrentSessionId,
    refreshSessions,
    forkSession,
  };
}
