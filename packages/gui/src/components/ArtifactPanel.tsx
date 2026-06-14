import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Artifact } from "scout-core";
import { Download, RefreshCw, X } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

const artifactScrollPositions = new Map<string, number>();

export function ArtifactPanel({
  artifact,
  baseUrl,
  token,
  onClose,
  embedded = false,
}: {
  artifact: Artifact;
  baseUrl: string;
  token: string | null;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const requestRef = useRef(0);
  const previousPathRef = useRef(artifact.path);
  const objectUrlRef = useRef("");
  const iframeScrollRef = useRef({ x: 0, y: 0 });
  const preservedScrollRef = useRef(artifactScrollPositions.get(artifact.path) ?? 0);
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
    const sameArtifact = previousPathRef.current === artifact.path;
    const scrollTop = sameArtifact
      ? scrollRef.current?.scrollTop ?? artifactScrollPositions.get(artifact.path) ?? 0
      : 0;
    preservedScrollRef.current = scrollTop;
    artifactScrollPositions.set(artifact.path, scrollTop);
    const iframeScroll = sameArtifact
      ? readIframeScroll(iframeRef.current)
      : { x: 0, y: 0 };
    iframeScrollRef.current = iframeScroll;
    previousPathRef.current = artifact.path;
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
    const request = fetch(`${baseUrl}/artifacts/content?${params}`, {
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
              ? await inlineLocalAssets(text, artifact.path, baseUrl, token, controller.signal)
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
  }, [artifact.path, artifact.version, baseUrl, token, refresh, artifact.renderer]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    window.clearTimeout(restoreTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    preserveScrollThroughLayout();
  }, [content, url, artifact.path]);

  const blocked = artifact.renderer === "html" && hasExternalAssets(content);

  return (
    <div className={`flex flex-col h-full bg-scout-canvas ${embedded ? "" : "min-h-0"}`}>
      <div className="h-11 px-3 flex items-center gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-normal truncate text-scout-text">{artifact.title}</div>
          <div className="text-[10px] text-scout-muted truncate">{artifact.path}</div>
        </div>
        {url && (
          <a
            href={url}
            download={artifact.name}
            className="p-2 text-scout-muted hover:text-scout-text hover:bg-scout-lift rounded-btn transition-colors"
            title="Download"
          >
            <Download size={17} />
          </a>
        )}
        <button
          onClick={() => setRefresh((value) => value + 1)}
          className="p-2 text-scout-muted hover:text-scout-text hover:bg-scout-lift rounded-btn transition-colors"
          title="Refresh"
        >
          <RefreshCw size={17} className={isRefreshing ? "animate-spin" : ""} />
        </button>
        <button
          onClick={onClose}
          className="p-2 text-scout-muted hover:text-scout-text hover:bg-scout-lift rounded-btn transition-colors"
          title="Close"
        >
          <X size={18} />
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          if (restoringScrollRef.current) return;
          const scrollTop = event.currentTarget.scrollTop;
          preservedScrollRef.current = scrollTop;
          artifactScrollPositions.set(artifact.path, scrollTop);
        }}
        className="flex-1 min-h-0 overflow-auto p-4 bg-scout-canvas"
      >
        {blocked && (
          <p className="mb-3 rounded-card border border-scout-warning/40 bg-scout-warning-muted p-2 text-xs text-scout-warning">
            External assets were blocked. HTML previews must be self-contained.
          </p>
        )}
        {error && <p className="text-sm text-scout-error">{error}</p>}
        {!error && !url && <p className="text-sm text-scout-muted">Loading artifact...</p>}
        {artifact.renderer === "image" && url && (
          <img src={url} alt={artifact.title} className="max-w-full mx-auto rounded-card" />
        )}
        {artifact.renderer === "html" && content && (
          <iframe
            ref={iframeRef}
            onLoad={() => restoreIframeScroll(iframeRef.current, iframeScrollRef.current)}
            title={artifact.title}
            srcDoc={sandboxHtml(content, artifact.path, baseUrl)}
            sandbox="allow-scripts"
            className="w-full h-full min-h-[70vh] bg-white rounded-card border border-scout-hairline"
          />
        )}
        {artifact.renderer === "markdown" && content && (
          <div className="prose-scout">
            <MarkdownRenderer content={content} baseUrl={baseUrl} token={token} artifactPath={artifact.path} />
          </div>
        )}
        {artifact.renderer === "json" && content && (
          <pre className="text-xs whitespace-pre-wrap">{formatJson(content)}</pre>
        )}
        {artifact.renderer === "csv" && content && <CsvPreview content={content} />}
        {(artifact.renderer === "code" || artifact.renderer === "text") && content && (
          <pre className="text-xs whitespace-pre-wrap font-mono">{content}</pre>
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
  token: string | null,
  signal: AbortSignal,
) {
  const directory = artifactPath.includes("/") ? artifactPath.slice(0, artifactPath.lastIndexOf("/") + 1) : "";
  const matches = [...content.matchAll(/(\b(?:src|poster)\s*=\s*["'])(?!data:|https?:|\/\/|#|javascript:)([^"']+)(["'])/gi)];
  let result = content;
  for (const match of matches) {
    const relative = match[2];
    const path = `${directory}${relative}`.replace(/\/+/g, "/");
    const response = await fetch(`${baseUrl}/artifacts/content?path=${encodeURIComponent(path)}`, {
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

function CsvPreview({ content }: { content: string }) {
  const rows = content.trim().split("\n").slice(0, 50).map((line) => line.split(","));
  if (rows.length === 0) return null;
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="border border-scout-hairline px-2 py-1 text-left font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border border-scout-hairline px-2 py-1">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
