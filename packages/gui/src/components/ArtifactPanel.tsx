import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Artifact } from "scout-core";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PixelDazed } from "./PixelArt";
import { PixelPet } from "./PixelPet";
import { PanelBreadcrumb, pathCrumbs } from "./ui/PanelBreadcrumb";
import { IconButton } from "./ui/IconButton";
import { Badge } from "./ui/Badge";

const artifactScrollPositions = new Map<string, number>();

export function ArtifactPanel({
  artifact,
  baseUrl,
  token,
  embedded = false,
  compact = false,
  scope = null,
  contentEndpoint = "/artifacts/content",
  leadingActions,
}: {
  artifact: Artifact;
  baseUrl: string;
  token: string | null;
  embedded?: boolean;
  compact?: boolean;
  /** Disambiguates identical relative paths in personal and shared workspaces. */
  scope?: string | null;
  /** Content API used by chat artifacts or the workspace browser. */
  contentEndpoint?: string;
  /**
   * Controls from the surface hosting this preview, placed first in the
   * breadcrumb's action row. The workspace browser puts its tree toggle and
   * refresh here so the nested preview does not need a second breadcrumb.
   */
  leadingActions?: React.ReactNode;
}) {
  const artifactKey = `${scope ?? "workspace"}:${artifact.path}`;
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const requestRef = useRef(0);
  const previousArtifactRef = useRef(artifactKey);
  const objectUrlRef = useRef("");
  const iframeScrollRef = useRef({ x: 0, y: 0 });
  const preservedScrollRef = useRef(artifactScrollPositions.get(artifactKey) ?? 0);
  const restoringScrollRef = useRef(false);
  const restoreTimerRef = useRef<number | undefined>(undefined);

  const restoreScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    restoringScrollRef.current = true;
    element.scrollTop = preservedScrollRef.current;
    requestAnimationFrame(() => {
      restoringScrollRef.current = false;
    });
  };

  const preserveScrollThroughLayout = () => {
    window.clearTimeout(restoreTimerRef.current);
    restoreScroll();
    restoreTimerRef.current = window.setTimeout(restoreScroll, 250);
  };

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestRef.current;
    const sameArtifact = previousArtifactRef.current === artifactKey;
    const scrollTop = sameArtifact
      ? scrollRef.current?.scrollTop ?? artifactScrollPositions.get(artifactKey) ?? 0
      : 0;
    preservedScrollRef.current = scrollTop;
    artifactScrollPositions.set(artifactKey, scrollTop);
    const iframeScroll = sameArtifact
      ? readIframeScroll(iframeRef.current)
      : { x: 0, y: 0 };
    iframeScrollRef.current = iframeScroll;
    previousArtifactRef.current = artifactKey;
    setError("");
    setIsRefreshing(true);
    if (!sameArtifact) {
      setContent("");
      setUrl("");
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    const params = new URLSearchParams({
      path: artifact.path,
      version: artifact.version,
      refresh: String(refresh),
    });
    if (scope) params.set("scope", scope);
    const request = fetch(`${baseUrl}${contentEndpoint}?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Artifact is unavailable");
        const blob = await response.blob();
        if (requestId !== requestRef.current) return;
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = nextUrl;
        setUrl(nextUrl);
        if (artifact.renderer !== "image") {
          const text = await blob.text();
          const nextContent =
            artifact.renderer === "html"
              ? await inlineLocalAssets(
                  text,
                  artifact.path,
                  baseUrl,
                  contentEndpoint,
                  token,
                  controller.signal,
                  scope,
                )
              : text;
          if (requestId !== requestRef.current) return;
          setContent(nextContent);
        }
        requestAnimationFrame(() => {
          if (requestId !== requestRef.current) return;
          preserveScrollThroughLayout();
        });
      })
      .catch((err) => {
        if (requestId === requestRef.current && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) setIsRefreshing(false);
      });
    void request;
    return () => {
      controller.abort();
    };
  }, [artifact.path, artifact.version, artifactKey, baseUrl, contentEndpoint, token, refresh, artifact.renderer, scope]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    window.clearTimeout(restoreTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    preserveScrollThroughLayout();
  }, [content, url, artifactKey]);

  const blocked = artifact.renderer === "html" && hasExternalAssets(content);
  const rendererLabel = artifact.renderer === "markdown" ? "MD" : artifact.renderer.toUpperCase();
  const canCopy = !!content && artifact.renderer !== "html";

  const copyContent = () => {
    if (!canCopy) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className={`flex flex-col h-full bg-scout-canvas ${embedded ? "" : "min-h-0"}`}>
      <PanelBreadcrumb
        crumbs={[
          ...(scope === "shared" ? [{ label: "Shared" }] : []),
          ...pathCrumbs(artifact.path),
        ]}
        meta={
          <span className="flex items-center gap-1.5">
            {!compact && (
              <Badge uppercase className="font-semibold">
                {rendererLabel}
              </Badge>
            )}
            {formatSize(artifact.size)}
          </span>
        }
        actions={
          <>
            {/* Actions belonging to the file itself. The pane's expand and close
                controls live once in the tab strip above, not per surface. */}
            {leadingActions}
            {canCopy && (
              <IconButton label="Copy artifact content" onClick={copyContent}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </IconButton>
            )}
            {url && (
              <a
                href={url}
                download={artifact.name}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-btn text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
                title="Download"
                aria-label="Download artifact"
              >
                <Download size={16} />
              </a>
            )}
            <IconButton
              label="Refresh"
              onClick={() => setRefresh((value) => value + 1)}
              disabled={isRefreshing}
            >
              <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
            </IconButton>
          </>
        }
      />
      <div
        ref={scrollRef}
        onScroll={(event) => {
          if (restoringScrollRef.current) return;
          const scrollTop = event.currentTarget.scrollTop;
          preservedScrollRef.current = scrollTop;
          artifactScrollPositions.set(artifactKey, scrollTop);
        }}
        className={`flex-1 min-h-0 overflow-auto bg-scout-canvas ${
          artifact.renderer === "markdown" ? "px-5 py-8" : "p-4"
        }`}
      >
        {blocked && (
          <p className="mb-3 rounded-card border border-scout-warning/25 bg-scout-warning-muted p-3 text-caption text-scout-warning">
            External assets were blocked. HTML previews must be self-contained.
          </p>
        )}
        {error && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <PixelDazed size={72} />
            <p className="text-label text-scout-error">{error}</p>
          </div>
        )}
        {!error && !url && (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4">
            <PixelPet working inline size={44} />
            <p className="text-label font-semibold text-scout-text">Loading artifact…</p>
          </div>
        )}
        {artifact.renderer === "image" && url && (
          <div className="flex min-h-full items-start justify-center">
            <img src={url} alt={artifact.title} className="max-w-full rounded-card border border-scout-hairline-faint shadow-pop" />
          </div>
        )}
        {artifact.renderer === "html" && content && (
          <iframe
            ref={iframeRef}
            onLoad={() => restoreIframeScroll(iframeRef.current, iframeScrollRef.current)}
            title={artifact.title}
            srcDoc={sandboxHtml(content, artifact.path, baseUrl)}
            sandbox="allow-scripts"
            className="w-full h-full min-h-[70vh] bg-white rounded-card border border-scout-hairline-faint"
          />
        )}
        {artifact.renderer === "markdown" && content && (
          <div className="artifact-document prose-scout mx-auto max-w-[760px]">
            <MarkdownRenderer
              content={content}
              baseUrl={baseUrl}
              token={token}
              artifactPath={artifact.path}
              contentEndpoint={contentEndpoint}
              scope={scope}
            />
          </div>
        )}
        {artifact.renderer === "json" && content && (
          <pre className="rounded-card border border-scout-hairline-faint bg-scout-code-bg p-4 text-caption whitespace-pre-wrap">{formatJson(content)}</pre>
        )}
        {artifact.renderer === "csv" && content && <CsvPreview content={content} />}
        {(artifact.renderer === "code" || artifact.renderer === "text") && content && (
          <pre className="rounded-card border border-scout-hairline-faint bg-scout-code-bg p-4 text-caption whitespace-pre-wrap font-mono">{content}</pre>
        )}
      </div>
    </div>
  );
}

function readIframeScroll(iframe: HTMLIFrameElement | null) {
  try {
    return { x: iframe?.contentWindow?.scrollX ?? 0, y: iframe?.contentWindow?.scrollY ?? 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function restoreIframeScroll(iframe: HTMLIFrameElement | null, position: { x: number; y: number }) {
  try {
    iframe?.contentWindow?.scrollTo(position.x, position.y);
  } catch {
    // Sandboxed/cross-origin iframe; parent panel scroll is still preserved.
  }
}

function hasExternalAssets(content: string) {
  return (
    /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(content) ||
    /url\(\s*["']?(?:https?:)?\/\//i.test(content)
  );
}

function sandboxHtml(content: string, _artifactPath: string, _baseUrl: string) {
  return content.replace(/<script\b[^>]*\ssrc\s*=\s*["'][^"']+["'][^>]*>/gi, "<!-- blocked -->");
}

async function inlineLocalAssets(
  content: string,
  artifactPath: string,
  baseUrl: string,
  contentEndpoint: string,
  token: string | null,
  signal: AbortSignal,
  scope: string | null,
) {
  const directory = artifactPath.includes("/") ? artifactPath.slice(0, artifactPath.lastIndexOf("/") + 1) : "";
  const matches = [...content.matchAll(/(\b(?:src|poster)\s*=\s*["'])(?!data:|https?:|\/\/|#|javascript:)([^"']+)(["'])/gi)];
  let result = content;
  for (const match of matches) {
    const relative = match[2];
    const path = `${directory}${relative}`.replace(/\/+/g, "/");
    const params = new URLSearchParams({ path });
    if (scope) params.set("scope", scope);
    const response = await fetch(`${baseUrl}${contentEndpoint}?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
      signal,
    });
    if (!response.ok) continue;
    const dataUrl = await blobToDataUrl(await response.blob());
    result = result.replace(match[0], `${match[1]}${dataUrl}${match[3]}`);
  }
  return result;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function formatJson(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CSV_ROW_LIMIT = 50;

/**
 * Minimal RFC-4180 split: `line.split(",")` broke every quoted field that
 * contained a comma, which is exactly why quoting exists.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

function CsvPreview({ content }: { content: string }) {
  const allLines = content.trim().split("\n");
  const rows = allLines.slice(0, CSV_ROW_LIMIT).map(splitCsvLine);
  const truncated = allLines.length > CSV_ROW_LIMIT;
  if (rows.length === 0) return null;
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <div className="overflow-x-auto rounded-card border border-scout-hairline-faint bg-scout-panel/70">
      <table className="w-full text-caption border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="border-b border-r border-scout-hairline-faint bg-scout-input-bg px-2 py-1.5 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border-b border-r border-scout-hairline-faint px-2 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* The row cap used to be silent, so a 10k-row file looked like a 50-row file. */}
      {truncated && (
        <p className="border-t border-scout-hairline-faint px-2 py-1.5 text-micro text-scout-muted">
          Showing the first {CSV_ROW_LIMIT} of {allLines.length} rows.
        </p>
      )}
    </div>
  );
}
