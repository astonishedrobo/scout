import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, ArtifactRenderer } from "scout-core";
import {
  ChevronRight,
  File,
  FileCode2,
  FileQuestion,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  Image,
  Loader2,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import { ArtifactPanel } from "./ArtifactPanel";
import { useMediaQuery } from "../hooks/usePanelPrefs";

export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  scope?: string | null;
  children?: FileTreeNode[];
  size?: number;
  mime_type?: string;
  renderer?: ArtifactRenderer | null;
  version?: string;
  truncated?: boolean;
};

type FileSelection = {
  node: FileTreeNode;
  scope: string;
};

type FileExplorerPanelProps = {
  baseUrl: string;
  token: string | null;
  onClose: () => void;
  /** Changes when an agent turn completes so generated files appear promptly. */
  refreshSignal?: string;
};

function nodeKey(node: FileTreeNode, scope: string): string {
  return `${scope}:${node.path || node.name}`;
}

function FileKindIcon({ node }: { node: FileTreeNode }) {
  const renderer = node.renderer;
  const className = "shrink-0 text-scout-muted";
  if (renderer === "image") return <Image size={15} className="shrink-0 text-scout-lavender" />;
  if (renderer === "csv") return <Table2 size={15} className="shrink-0 text-scout-success" />;
  if (renderer === "code" || renderer === "json") return <FileCode2 size={15} className={className} />;
  if (renderer === "markdown" || renderer === "text") return <FileText size={15} className={className} />;
  return <File size={15} className={className} />;
}

function TreeNodeRow({
  node,
  scope,
  depth,
  expanded,
  selectedKey,
  forceExpanded,
  showFullPath,
  loadingKeys,
  onToggle,
  onSelect,
}: {
  node: FileTreeNode;
  scope: string;
  depth: number;
  expanded: Set<string>;
  selectedKey: string | null;
  forceExpanded: boolean;
  showFullPath: boolean;
  loadingKeys: Set<string>;
  onToggle: (node: FileTreeNode, scope: string, key: string) => void;
  onSelect: (selection: FileSelection) => void;
}) {
  const key = nodeKey(node, scope);
  const isDir = node.type === "dir";
  const isOpen = isDir && (forceExpanded || expanded.has(key));
  const isSelected = !isDir && selectedKey === key;
  const isLoading = isDir && loadingKeys.has(key);
  const childrenLoaded = node.children !== undefined;
  const children = node.children ?? [];

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDir) onToggle(node, scope, key);
          else onSelect({ node, scope });
        }}
        className={`group flex w-full items-center gap-1.5 rounded-lg px-2 py-[5px] text-left text-[13px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-scout-muted/50 ${
          isSelected
            ? "bg-scout-lift text-scout-text"
            : "text-scout-muted hover:bg-scout-lift/70 hover:text-scout-text"
        }`}
        style={{ paddingLeft: 8 + depth * 13 }}
        title={node.path || node.name}
        aria-expanded={isDir ? isOpen : undefined}
        aria-selected={!isDir ? isSelected : undefined}
      >
        {isDir ? (
          <ChevronRight
            size={13}
            className={`shrink-0 text-scout-muted/75 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        {isLoading ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-scout-muted" />
        ) : isDir ? (
          isOpen ? (
            <FolderOpen size={15} className="shrink-0 text-scout-cyan/85" />
          ) : (
            <Folder size={15} className="shrink-0 text-scout-cyan/85" />
          )
        ) : (
          <FileKindIcon node={node} />
        )}
        <span className="min-w-0 truncate">{showFullPath && !isDir ? node.path : node.name}</span>
        {isDir && childrenLoaded && children.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-scout-muted/60">
            {children.length}
          </span>
        )}
      </button>
      {isDir && isOpen && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNodeRow
              key={nodeKey(child, scope)}
              node={child}
              scope={scope}
              depth={depth + 1}
              expanded={expanded}
              selectedKey={selectedKey}
              forceExpanded={forceExpanded}
              showFullPath={showFullPath}
              loadingKeys={loadingKeys}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {isDir && isOpen && childrenLoaded && children.length === 0 && !isLoading && (
        <div
          className="px-2 py-1 text-[11px] italic text-scout-muted/55"
          style={{ paddingLeft: 8 + (depth + 1) * 13 + 13 }}
        >
          Empty
        </div>
      )}
      {isDir && isOpen && node.truncated && (
        <div
          className="px-2 py-1 text-[11px] text-scout-warning/80"
          style={{ paddingLeft: 8 + (depth + 1) * 13 + 13 }}
        >
          More items are hidden
        </div>
      )}
    </div>
  );
}

function replaceDirectory(
  roots: FileTreeNode[],
  scope: string,
  path: string,
  children: FileTreeNode[],
  truncated: boolean,
): FileTreeNode[] {
  const replace = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.map((node) => {
    if (node.type === "dir" && node.path === path) return { ...node, children, truncated };
    if (!node.children) return node;
    return { ...node, children: replace(node.children) };
  });
  return roots.map((root) => (
    root.scope === scope ? { ...root, children: replace(root.children ?? []) } : root
  ));
}

function preserveLoadedDirectories(
  nextRoots: FileTreeNode[],
  previousRoots: FileTreeNode[],
): FileTreeNode[] {
  const merge = (next: FileTreeNode, previous: FileTreeNode | undefined): FileTreeNode => {
    if (next.type !== "dir" || !previous || previous.type !== "dir") return next;
    if (next.children === undefined) {
      return previous.children === undefined
        ? next
        : { ...next, children: previous.children, truncated: previous.truncated };
    }
    return {
      ...next,
      children: next.children.map((child) =>
        merge(child, previous.children?.find((candidate) => candidate.path === child.path)),
      ),
    };
  };
  return nextRoots.map((root) =>
    merge(root, previousRoots.find((candidate) => candidate.scope === root.scope)),
  );
}

function findFile(
  roots: FileTreeNode[],
  path: string,
  scope: string,
): FileSelection | null {
  const root = roots.find((candidate) => (candidate.scope ?? null) === scope);
  const walk = (nodes: FileTreeNode[]): FileTreeNode | null => {
    for (const node of nodes) {
      if (node.type === "file" && node.path === path) return node;
      const match = walk(node.children ?? []);
      if (match) return match;
    }
    return null;
  };
  const node = root ? walk(root.children ?? []) : null;
  return node ? { node, scope } : null;
}

function toArtifact(selection: FileSelection): Artifact | null {
  const { node, scope } = selection;
  const renderer = node.renderer;
  if (!renderer) return null;
  return {
    id: `file:${scope}:${node.path}`,
    path: node.path,
    name: node.name,
    title: node.name,
    mime_type: node.mime_type ?? "application/octet-stream",
    renderer,
    size: node.size ?? 0,
    version: node.version ?? "current",
    presentation: "panel",
  };
}

export function FileExplorerPanel({
  baseUrl,
  token,
  onClose,
  refreshSignal,
}: FileExplorerPanelProps) {
  const [roots, setRoots] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileTreeNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [treeVisible, setTreeVisible] = useState(true);
  const rootsRef = useRef<FileTreeNode[]>([]);
  const loadedDirectoriesRef = useRef<Set<string>>(new Set());
  const isCompactViewport = useMediaQuery("(max-width: 639px)");

  const selectFile = useCallback((next: FileSelection) => {
    setSelection(next);
    if (isCompactViewport) setTreeVisible(false);
  }, [isCompactViewport]);

  const closePreview = useCallback(() => {
    setSelection(null);
    if (isCompactViewport) setTreeVisible(true);
  }, [isCompactViewport]);

  const fetchDirectory = useCallback(async (scope: string, path: string) => {
    const params = new URLSearchParams({ scope, path });
    const response = await fetch(`${baseUrl}/workspace/entries?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.detail ?? `Failed to load folder (${response.status})`);
    }
    return response.json() as Promise<{ entries?: FileTreeNode[]; truncated?: boolean }>;
  }, [baseUrl, token]);

  const loadDirectory = useCallback(async (node: FileTreeNode, scope: string) => {
    const key = `${scope}:${node.path}`;
    loadedDirectoriesRef.current.add(key);
    setLoadingKeys((current) => new Set(current).add(key));
    try {
      const data = await fetchDirectory(scope, node.path);
      const next = replaceDirectory(
        rootsRef.current,
        scope,
        node.path,
        data.entries ?? [],
        !!data.truncated,
      );
      rootsRef.current = next;
      setRoots(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [fetchDirectory]);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetch(`${baseUrl}/workspace/roots`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(body?.detail ?? `Failed to load files (${resp.status})`);
      }
      const data = (await resp.json()) as { roots?: FileTreeNode[] };
      let nextRoots = preserveLoadedDirectories(data.roots ?? [], rootsRef.current);
      const loadedDirectories = [...loadedDirectoriesRef.current];
      const refreshed = await Promise.all(loadedDirectories.map(async (key) => {
        const separator = key.indexOf(":");
        const scope = key.slice(0, separator);
        const path = key.slice(separator + 1);
        try {
          const directory = await fetchDirectory(scope, path);
          return { scope, path, directory };
        } catch {
          return null;
        }
      }));
      for (const result of refreshed) {
        if (!result) continue;
        nextRoots = replaceDirectory(
          nextRoots,
          result.scope,
          result.path,
          result.directory.entries ?? [],
          !!result.directory.truncated,
        );
      }
      rootsRef.current = nextRoots;
      setRoots(nextRoots);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const root of nextRoots) next.add(nodeKey(root, root.scope ?? "workspace"));
        return next;
      });
      setSelection((current) => {
        if (!current) return null;
        return findFile(nextRoots, current.node.path, current.scope);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, fetchDirectory, token]);

  useEffect(() => {
    void loadTree();
  }, [loadTree, refreshSignal]);

  useEffect(() => {
    const refreshOnFocus = () => void loadTree();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [loadTree]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearchResults([]);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      const params = new URLSearchParams({ query: trimmed });
      fetch(`${baseUrl}/workspace/search?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Search failed (${response.status})`);
          return response.json() as Promise<{ files?: FileTreeNode[] }>;
        })
        .then((data) => setSearchResults(data.files ?? []))
        .catch((err) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setSearchResults([]);
          }
        })
        .finally(() => setSearching(false));
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl, query, token, refreshSignal]);

  const toggle = useCallback((node: FileTreeNode, scope: string, key: string) => {
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening && node.children === undefined) void loadDirectory(node, scope);
  }, [expanded, loadDirectory]);

  const fileCount = useMemo(() => {
    let count = 0;
    const walk = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") count += 1;
        walk(node.children ?? []);
      }
    };
    walk(roots);
    return count;
  }, [roots]);

  const visibleRoots = useMemo(() => {
    if (!query.trim()) return roots;
    return roots.flatMap((root) => {
      const children = searchResults.filter((node) => node.scope === root.scope);
      return children.length > 0 ? [{ ...root, children }] : [];
    });
  }, [query, roots, searchResults]);
  const selectedKey = selection ? nodeKey(selection.node, selection.scope) : null;
  const artifact = selection ? toArtifact(selection) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-scout-canvas">
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-transparent bg-scout-panel/30 px-3">
        <FolderTree size={16} className="shrink-0 text-scout-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-[-0.01em] text-scout-text">Files</div>
          <div className="truncate text-[11px] text-scout-muted">
            {loading && roots.length === 0
              ? "Loading files…"
              : error
                ? "Files unavailable"
                : `${fileCount} loaded file${fileCount === 1 ? "" : "s"}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTreeVisible((visible) => !visible)}
          className="rounded-lg p-2 text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
          title={treeVisible ? "Hide file tree" : "Show file tree"}
          aria-label={treeVisible ? "Hide file tree" : "Show file tree"}
          aria-pressed={treeVisible}
        >
          {treeVisible ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
        </button>
        <button
          type="button"
          onClick={() => void loadTree()}
          className="rounded-lg p-2 text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
          title="Refresh files"
          aria-label="Refresh files"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
          title="Close workspace"
          aria-label="Close workspace"
        >
          <X size={17} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {treeVisible && (
          <aside className={`order-2 flex shrink-0 flex-col bg-scout-panel/70 ${isCompactViewport ? "w-full" : "w-[clamp(180px,32%,240px)] border-l border-scout-hairline-faint"}`}>
            <div className="shrink-0 p-2.5">
              <label className="flex h-9 items-center gap-2 rounded-lg border border-scout-hairline-faint bg-scout-input-bg/75 px-2.5 text-scout-muted transition-colors focus-within:border-scout-muted/40 focus-within:bg-scout-input-bg">
                <Search size={14} className="shrink-0" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a file"
                  aria-label="Find a workspace file"
                  className="min-w-0 flex-1 bg-transparent text-xs text-scout-text outline-none placeholder:text-scout-muted/65"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="rounded p-0.5 hover:bg-scout-lift hover:text-scout-text"
                    aria-label="Clear file search"
                  >
                    <X size={12} />
                  </button>
                )}
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
              {loading && roots.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-scout-muted">
                  <Loader2 size={15} className="animate-spin" />
                  Loading…
                </div>
              )}
              {error && (
                <div className="m-2 rounded-xl border border-scout-error/20 bg-scout-error-muted px-3 py-2 text-xs text-scout-error">
                  {error}
                </div>
              )}
              {!loading && !error && roots.length === 0 && (
                <div className="px-3 py-10 text-center text-xs text-scout-muted">No files yet</div>
              )}
              {!loading && !error && roots.length > 0 && visibleRoots.length === 0 && (
                <div className="px-3 py-10 text-center text-xs text-scout-muted">
                  {searching ? "Searching…" : "No matching files"}
                </div>
              )}
              {visibleRoots.map((root) => (
                <TreeNodeRow
                  key={nodeKey(root, root.scope ?? "workspace")}
                  node={root}
                  scope={root.scope ?? "workspace"}
                  depth={0}
                  expanded={expanded}
                  selectedKey={selectedKey}
                  forceExpanded={!!query.trim()}
                  showFullPath={!!query.trim()}
                  loadingKeys={loadingKeys}
                  onToggle={toggle}
                  onSelect={selectFile}
                />
              ))}
            </div>
          </aside>
        )}

        <main className={`order-1 min-w-0 flex-1 bg-scout-canvas ${isCompactViewport && treeVisible ? "hidden" : ""}`}>
          {selection && artifact ? (
            <ArtifactPanel
              artifact={artifact}
              scope={selection.scope}
              baseUrl={baseUrl}
              token={token}
              onClose={closePreview}
              embedded
              compact
              contentEndpoint="/workspace/content"
            />
          ) : selection ? (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <div className="max-w-xs">
                <FileQuestion size={23} className="mx-auto mb-4 text-scout-muted/75" />
                <p className="truncate text-sm font-medium text-scout-text">{selection.node.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-scout-muted">
                  This file type does not have an in-app preview yet.
                </p>
                <button
                  type="button"
                  onClick={closePreview}
                  className="mt-4 rounded-xl border border-scout-hairline-faint bg-scout-input-bg px-3 py-2 text-xs font-medium text-scout-text transition-colors hover:bg-scout-lift"
                >
                  Clear selection
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <div className="max-w-xs">
                <FileText size={24} className="mx-auto mb-4 text-scout-muted/75" />
                <p className="text-sm font-medium text-scout-text">Open a file</p>
                <p className="mt-1 text-xs leading-relaxed text-scout-muted">
                  Select a file from the browser on the right to preview it here.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
