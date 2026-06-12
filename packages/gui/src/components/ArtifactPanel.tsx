import { useEffect, useState } from "react";
import type { Artifact } from "scout-core";
import { Download, RefreshCw, X } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

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

  useEffect(() => {
    let objectUrl = "";
    const controller = new AbortController();
    setError("");
    setContent("");
    setUrl("");
    const params = new URLSearchParams({
      path: artifact.path,
      version: artifact.version,
      refresh: String(refresh),
    });
    fetch(`${baseUrl}/artifacts/content?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Artifact is unavailable");
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        if (artifact.renderer !== "image") setContent(await blob.text());
      })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.path, artifact.version, baseUrl, token, refresh, artifact.renderer]);

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
          <RefreshCw size={17} />
        </button>
        <button
          onClick={onClose}
          className="p-2 text-scout-muted hover:text-scout-text hover:bg-scout-lift rounded-btn transition-colors"
          title="Close"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4 bg-scout-canvas">
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
            title={artifact.title}
            srcDoc={sandboxHtml(content)}
            sandbox="allow-scripts"
            className="w-full h-full min-h-[70vh] bg-white rounded-card border border-scout-hairline"
          />
        )}
        {artifact.renderer === "markdown" && content && (
          <div className="prose-scout">
            <MarkdownRenderer content={content} />
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

function hasExternalAssets(content: string) {
  return (
    /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(content) ||
    /url\(\s*["']?(?:https?:)?\/\//i.test(content)
  );
}

function sandboxHtml(content: string) {
  return content.replace(/<script\b[^>]*\ssrc\s*=\s*["'][^"']+["'][^>]*>/gi, "<!-- blocked -->");
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
