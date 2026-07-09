import { useCallback, useEffect, useState } from "react";

const SIDEBAR_KEY = "scout-sidebar-collapsed";
const ARTIFACT_KEY = "scout-artifact-size";

export function usePanelPrefs() {
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => {
    return localStorage.getItem(SIDEBAR_KEY) === "true";
  });

  const [artifactDefaultSize, setArtifactDefaultSizeState] = useState(() => {
    const v = localStorage.getItem(ARTIFACT_KEY);
    const parsed = v ? parseFloat(v) : NaN;
    // Clamp to the panel's min/max; discard corrupt persisted values.
    return Number.isFinite(parsed) ? Math.min(70, Math.max(20, parsed)) : 38;
  });

  const setSidebarCollapsed = useCallback((v: boolean) => {
    setSidebarCollapsedState(v);
    localStorage.setItem(SIDEBAR_KEY, String(v));
  }, []);

  const setArtifactDefaultSize = useCallback((v: number) => {
    const next = Math.min(70, Math.max(20, v));
    setArtifactDefaultSizeState(next);
    localStorage.setItem(ARTIFACT_KEY, String(next));
  }, []);

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
    artifactDefaultSize,
    setArtifactDefaultSize,
  };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
