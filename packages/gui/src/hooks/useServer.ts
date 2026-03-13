import { useState, useEffect, useRef } from "react";

interface UseServerReturn {
  baseUrl: string;
  isReady: boolean;
  isMultiUser: boolean;
  error: string | null;
  warnings: string[];
}

/**
 * Poll the server health endpoint until it's ready.
 * In GUI mode, the server is spawned externally by the CLI launcher.
 * The base URL is derived from the current origin or a query param.
 */
export function useServer(): UseServerReturn {
  const params = new URLSearchParams(window.location.search);
  const baseUrl = params.get("server") || window.location.origin;

  const [isReady, setIsReady] = useState(false);
  const [isMultiUser, setIsMultiUser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const polling = useRef(false);

  useEffect(() => {
    if (polling.current) return;
    polling.current = true;

    let cancelled = false;

    const poll = async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !cancelled) {
        try {
          const resp = await fetch(`${baseUrl}/health`);
          if (resp.ok) {
            const body = await resp.json();
            if (body.status === "ok") {
              setIsReady(true);
              setIsMultiUser(!!body.multi_user);
              // Fetch warnings after server is ready
              try {
                const wr = await fetch(`${baseUrl}/warnings`);
                if (wr.ok) {
                  const wd = await wr.json();
                  setWarnings(wd.warnings ?? []);
                }
              } catch { /* best effort */ }
              return;
            }
            if (body.status === "error") {
              setError(body.error || "Server initialization failed");
              return;
            }
          }
        } catch {
          // server not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!cancelled) {
        setError("Server did not become ready within 60 seconds");
      }
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return { baseUrl, isReady, isMultiUser, error, warnings };
}
