/**
 * Hook for managing the Python server lifecycle.
 */

import { useState, useEffect } from "react";
import { ScoutServer, type ServerOptions } from "scout-core";

interface UseServerReturn {
  server: ScoutServer | null;
  baseUrl: string | null;
  isReady: boolean;
  error: string | null;
  warnings: readonly string[];
}

export function useServer(opts: ServerOptions): UseServerReturn {
  const [server, setServer] = useState<ScoutServer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  useEffect(() => {
    const srv = new ScoutServer(opts);
    setServer(srv);

    srv
      .start()
      .then(() => {
        setIsReady(true);
        setWarnings(srv.warnings);
      })
      .catch((err: Error) => {
        setError(err.message);
        setWarnings(srv.warnings);
      });

    return () => {
      srv.stop();
    };
  }, [opts.cwd]);

  return {
    server,
    baseUrl: server ? server.baseUrl : null,
    isReady,
    error,
    warnings,
  };
}
