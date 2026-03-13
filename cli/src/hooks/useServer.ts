/**
 * Hook for managing the Python server lifecycle.
 */

import { useState, useEffect } from "react";
import { ScoutServer, type ServerOptions } from "../server.js";

interface UseServerReturn {
  server: ScoutServer | null;
  baseUrl: string | null;
  isReady: boolean;
  error: string | null;
}

export function useServer(opts: ServerOptions): UseServerReturn {
  const [server, setServer] = useState<ScoutServer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const srv = new ScoutServer(opts);
    setServer(srv);

    srv
      .start()
      .then(() => setIsReady(true))
      .catch((err: Error) => setError(err.message));

    return () => {
      srv.stop();
    };
  }, [opts.cwd]);

  return {
    server,
    baseUrl: server ? server.baseUrl : null,
    isReady,
    error,
  };
}
