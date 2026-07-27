import { useCallback, useMemo, useRef, useState } from "react";
import type { Artifact, FileChangeSet } from "scout-core";

/**
 * What can occupy the right panel. A discriminated union rather than four
 * booleans: the old model kept `activeArtifact` / `activeFileChanges` /
 * `filesExplorerOpen` / `agentsPanelOpen` in App, and every opener nulled the
 * other three — so opening a file destroyed the diff you were reading and threw
 * away the file tree's expansion state.
 */
export type RightPanelTab =
  | { kind: "files" }
  | { kind: "agents" }
  | { kind: "review"; changeSet: FileChangeSet }
  | { kind: "artifact"; artifact: Artifact };

export type RightPanelTabKind = RightPanelTab["kind"];

/**
 * Stable identity for a tab. Files and Agents are singletons; the other two are
 * one tab per subject, so clicking the same artifact chip twice activates the
 * existing tab instead of stacking a duplicate.
 */
export function tabKey(tab: RightPanelTab): string {
  switch (tab.kind) {
    case "files":
      return "files";
    case "agents":
      return "agents";
    case "review":
      return `review:${tab.changeSet.id}`;
    case "artifact":
      return `artifact:${tab.artifact.id}`;
  }
}

export interface OpenTab {
  key: string;
  tab: RightPanelTab;
  /**
   * Title the surface reported for itself, overriding the tab's default label.
   * Only the file explorer uses it, so its tab reads `report.py` once a file is
   * selected rather than a permanent "Files".
   */
  title?: string;
}

/** Beyond this the strip stops being readable and starts being a scroll chore. */
const MAX_TABS = 8;

export interface RightPanelTabsApi {
  tabs: OpenTab[];
  activeKey: string | null;
  active: OpenTab | null;
  open: (tab: RightPanelTab) => void;
  replace: (tab: RightPanelTab) => void;
  activate: (key: string) => void;
  close: (key: string) => void;
  closeAll: () => void;
  closeKinds: (kinds: RightPanelTabKind[]) => void;
  setTitle: (key: string, title: string | undefined) => void;
  /** True when a tab of this kind exists — for header buttons' pressed state. */
  has: (kind: RightPanelTabKind) => boolean;
  toggle: (tab: RightPanelTab) => void;
}

export function useRightPanelTabs(): RightPanelTabsApi {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Activation order, oldest first — the eviction policy needs "least recently
  // looked at", which the strip's own left-to-right order does not give us.
  const recency = useRef<string[]>([]);
  const touch = useCallback((key: string) => {
    recency.current = [...recency.current.filter((k) => k !== key), key];
  }, []);

  const activate = useCallback(
    (key: string) => {
      touch(key);
      setActiveKey(key);
    },
    [touch],
  );

  const open = useCallback(
    (tab: RightPanelTab) => {
      const key = tabKey(tab);
      setTabs((current) => {
        const at = current.findIndex((t) => t.key === key);
        if (at >= 0) {
          // Reopening an existing key refreshes its payload rather than
          // duplicating it — this is how a change set re-opened after an undo
          // picks up `undone: true` in the tab that is already on screen.
          const next = [...current];
          next[at] = { ...next[at], tab };
          return next;
        }
        const appended = [...current, { key, tab }];
        if (appended.length <= MAX_TABS) return appended;
        // Evict the least-recently-activated tab that is not the one we just
        // opened. Falling back to the first tab keeps this total: `recency`
        // can lag if a tab was never activated.
        const victim =
          recency.current.find((k) => k !== key && appended.some((t) => t.key === k)) ??
          appended.find((t) => t.key !== key)?.key;
        return victim ? appended.filter((t) => t.key !== victim) : appended;
      });
      activate(key);
    },
    [activate],
  );

  const close = useCallback(
    (key: string) => {
      const at = tabs.findIndex((t) => t.key === key);
      if (at < 0) return;
      recency.current = recency.current.filter((k) => k !== key);
      const next = tabs.filter((t) => t.key !== key);
      setTabs(next);
      if (activeKey === key) {
        // Neighbour on the right, then the left — closing a tab should not jump
        // you across the strip. Null closes the panel.
        setActiveKey(next[at]?.key ?? next[at - 1]?.key ?? null);
      }
    },
    [activeKey, tabs],
  );

  /**
   * Refresh an already-open tab's payload without opening or activating it.
   *
   * Distinct from `open` because the freshness effects (a new artifact version
   * arriving, a change set being undone) must not yank the panel to a tab you
   * were not looking at.
   */
  const replace = useCallback((tab: RightPanelTab) => {
    const key = tabKey(tab);
    setTabs((current) => {
      const at = current.findIndex((t) => t.key === key);
      if (at < 0 || current[at].tab === tab) return current;
      const next = [...current];
      next[at] = { ...next[at], tab };
      return next;
    });
  }, []);

  const closeAll = useCallback(() => {
    recency.current = [];
    setTabs([]);
    setActiveKey(null);
  }, []);

  /**
   * Close every tab of these kinds — used when the session changes, since an
   * artifact or a diff belongs to the transcript that produced it. The file tree
   * is workspace-scoped and deliberately survives.
   */
  const closeKinds = useCallback(
    (kinds: RightPanelTabKind[]) => {
      const next = tabs.filter((t) => !kinds.includes(t.tab.kind));
      if (next.length === tabs.length) return;
      const surviving = new Set(next.map((t) => t.key));
      recency.current = recency.current.filter((k) => surviving.has(k));
      setTabs(next);
      if (!activeKey || !surviving.has(activeKey)) {
        setActiveKey(next[next.length - 1]?.key ?? null);
      }
    },
    [activeKey, tabs],
  );

  const setTitle = useCallback((key: string, title: string | undefined) => {
    setTabs((current) => {
      const at = current.findIndex((t) => t.key === key);
      // Bail on an unchanged title: surfaces report this from an effect, and a
      // fresh array every time would loop.
      if (at < 0 || current[at].title === title) return current;
      const next = [...current];
      next[at] = { ...next[at], title };
      return next;
    });
  }, []);

  const has = useCallback(
    (kind: RightPanelTabKind) => tabs.some((t) => t.tab.kind === kind),
    [tabs],
  );

  const toggle = useCallback(
    (tab: RightPanelTab) => {
      const key = tabKey(tab);
      const existing = tabs.find((t) => t.key === key);
      // Only a visible tab toggles off; one hiding behind another activates.
      if (existing && activeKey === key) close(key);
      else open(tab);
    },
    [activeKey, close, open, tabs],
  );

  const active = useMemo(
    () => tabs.find((t) => t.key === activeKey) ?? null,
    [activeKey, tabs],
  );

  // Memoised so callers can put the whole api in an effect's dependency list
  // without the effect re-running on every render.
  return useMemo(
    () => ({
      tabs,
      activeKey,
      active,
      open,
      replace,
      activate,
      close,
      closeAll,
      closeKinds,
      setTitle,
      has,
      toggle,
    }),
    [tabs, activeKey, active, open, replace, activate, close, closeAll, closeKinds, setTitle, has, toggle],
  );
}
