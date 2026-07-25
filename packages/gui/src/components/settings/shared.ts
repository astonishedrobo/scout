import { useCallback, useMemo } from "react";

export interface StatusMessage {
  message: string;
  tone: "info" | "error";
}

/** Everything a settings section needs from the surface. */
export interface SectionProps {
  baseUrl: string;
  token?: string | null;
  isMultiUser?: boolean;
  /** Publishes to the surface's single live region. Pass null to clear. */
  setStatus: (status: StatusMessage | null) => void;
}

export function useAuthHeaders(token?: string | null): Record<string, string> {
  return useMemo(() => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [token]);
}

/** Pulls `detail` off a FastAPI error body, falling back to a caller message. */
export async function errorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Writes to the global config and reloads it.
 *
 * Only single-user mode can use this: `POST /config` and `/config/reload` are 403
 * in server mode for everyone, admins included, because config.yaml belongs to
 * the deployment. Sections gate on `isMultiUser` before offering the control at
 * all — the old panel offered a Save button that could only ever fail.
 */
export function useConfigWriter({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);

  return useCallback(
    async (values: Record<string, unknown>, label = "Saved.") => {
      setStatus({ message: "Saving…", tone: "info" });
      try {
        for (const [key, value] of Object.entries(values)) {
          const r = await fetch(`${baseUrl}/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ key, value, scope: "global" }),
          });
          if (!r.ok) throw new Error(await errorDetail(r, `Could not save ${key}.`));
        }
        const reload = await fetch(`${baseUrl}/config/reload`, {
          method: "POST",
          headers: authHeaders,
        });
        if (!reload.ok) throw new Error("Saved, but the server could not reload the config.");
        setStatus({ message: label, tone: "info" });
        return true;
      } catch (e) {
        setStatus({
          message: e instanceof Error ? e.message : "Could not save settings.",
          tone: "error",
        });
        return false;
      }
    },
    [baseUrl, authHeaders, setStatus],
  );
}
