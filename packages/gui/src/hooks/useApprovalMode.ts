import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalMode } from "scout-core";

const DEFAULT_MODE: ApprovalMode = "ask_always";

export function useApprovalMode({
  baseUrl,
  sessionId,
  token,
  isReady,
  ensureSession,
  defaultMode,
}: {
  baseUrl: string;
  sessionId: string | null;
  token: string | null;
  isReady: boolean;
  ensureSession: (initialMode?: ApprovalMode) => Promise<string>;
  defaultMode: ApprovalMode;
}) {
  const [mode, setModeState] = useState<ApprovalMode>(defaultMode);
  const [isChanging, setIsChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!isReady || !sessionId) {
      setModeState(defaultMode);
      setError(null);
      return;
    }
    const requestId = ++requestRef.current;
    fetch(`${baseUrl}/sessions/${sessionId}/approval-mode`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load approval mode");
        return response.json() as Promise<{ mode?: ApprovalMode }>;
      })
      .then((body) => {
        if (requestRef.current === requestId) {
          setModeState(body.mode ?? DEFAULT_MODE);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (requestRef.current === requestId) {
          setError(reason instanceof Error ? reason.message : "Could not load approval mode");
        }
      });
  }, [baseUrl, defaultMode, isReady, sessionId, token]);

  const setMode = useCallback(async (nextMode: ApprovalMode) => {
    if (nextMode === mode) return;
    const previous = mode;
    setModeState(nextMode);
    setIsChanging(true);
    setError(null);
    try {
      // A composer override chosen before the first message becomes the
      // session's initial mode. Creating it atomically avoids a GET/PUT race.
      if (!sessionId) {
        await ensureSession(nextMode);
        setModeState(nextMode);
        return;
      }
      const id = sessionId;
      const response = await fetch(`${baseUrl}/sessions/${id}/approval-mode`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ mode: nextMode }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.detail ?? "Could not update approval mode");
      }
      const body = await response.json() as { mode?: ApprovalMode };
      setModeState(body.mode ?? nextMode);
    } catch (reason) {
      setModeState(previous);
      setError(reason instanceof Error ? reason.message : "Could not update approval mode");
      throw reason;
    } finally {
      setIsChanging(false);
    }
  }, [baseUrl, ensureSession, mode, sessionId, token]);

  return { mode, setMode, isChanging, error };
}
