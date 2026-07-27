import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, AlertTriangle } from "lucide-react";
import { useState, useEffect, useMemo, memo } from "react";
import type { Components } from "react-markdown";
import { useTheme } from "../hooks/useTheme";
import { AuthenticatedImage } from "./AuthenticatedImage";
import { CodeBlock } from "./CodeBlock";

const mermaidCache = new Map<string, string>();
let mermaidModule: Promise<typeof import("mermaid")> | null = null;
function hashSource(source: string) {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

interface MarkdownRendererProps {
  content: string;
  baseUrl?: string;
  token?: string | null;
  artifactPath?: string;
  contentEndpoint?: string;
  scope?: string | null;
}

function MermaidDiagram({ source, theme }: { source: string; theme: "light" | "dark" | "soft" }) {
  // Cache key includes the theme: mermaid bakes colours into the SVG, so a
  // theme-keyless cache handed back a stale light-mode diagram after a switch.
  const cacheKey = `${theme}:${source}`;
  const [svg, setSvg] = useState(() => mermaidCache.get(cacheKey) ?? "");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const cached = mermaidCache.get(cacheKey);
    if (cached) {
      setSvg(cached);
      setError("");
      return;
    }
    setSvg("");
    setError("");
    if (!mermaidModule) mermaidModule = import("mermaid");
    mermaidModule
      .then(({ default: mermaid }) => {
        // Re-initialize on every render pass rather than once on the cached
        // module promise: initialize() is global and the theme can change after
        // the module has loaded.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "light" ? "neutral" : "dark",
        });
        return mermaid.render(`mermaid-${theme}-${hashSource(source)}`, source);
      })
      .then(({ svg: rendered }) => {
        mermaidCache.set(cacheKey, rendered);
        if (active) setSvg(rendered);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [source, theme, cacheKey]);

  if (error) {
    return (
      <div className="my-3 rounded-card border border-scout-error/25 bg-scout-error-muted p-3">
        <div className="flex items-center gap-2 text-caption font-medium text-scout-text">
          <AlertTriangle size={14} className="shrink-0 text-scout-error" />
          Could not render this diagram
        </div>
        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-micro text-scout-muted">{error}</pre>
      </div>
    );
  }

  if (!svg) {
    // Rendering pulls in mermaid on first use; without this the block was an
    // empty bordered box for as long as that took.
    return (
      <div className="my-3 flex items-center gap-2 rounded-card border border-scout-hairline bg-scout-panel px-3 py-6 text-caption text-scout-muted">
        <Loader2 size={14} className="shrink-0 animate-spin" />
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="my-3 overflow-x-auto rounded-card border border-scout-hairline bg-scout-panel p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function resolveMarkdownImage(src: string, artifactPath: string) {
  if (src.startsWith("data:image/")) return { direct: src };
  if (/^(?:https?:)?\/\//i.test(src) || src.startsWith("/") || src.includes("..")) return null;
  const directory = artifactPath.includes("/") ? artifactPath.slice(0, artifactPath.lastIndexOf("/") + 1) : "";
  return { artifact: `${directory}${src}`.replace(/\/+/g, "/") };
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  baseUrl = "",
  token = null,
  artifactPath = "",
  contentEndpoint = "/artifacts/content",
  scope = null,
}: MarkdownRendererProps) {
  const { theme } = useTheme();

  // The custom renderers MUST be referentially stable across re-renders:
  // a fresh inline `img` function is a new component type to React, which
  // unmounts and remounts every AuthenticatedImage (blob refetch → visible
  // flicker each time anything above re-renders, e.g. the 10s session poll).
  const components = useMemo<Components>(
    () => ({
        // Fenced blocks are <pre><code>…</code></pre>; CodeBlock already renders its own
        // container, so unwrap the outer <pre> to avoid a duplicate empty box.
        pre({ children }) {
          return <>{children}</>;
        },
        code({ className, children, node: _node, ...props }) {
          const code = String(children).replace(/\n$/, "");
          // Nested ``` inside a displayed file fence (e.g. ```mermaid) closes the outer
          // fence early and leaves a trailing empty ``` artifact — skip it.
          if (!code.trim()) return null;

          const match = /language-(\w+)/.exec(className || "");
          const language = match?.[1];

          if (language === "mermaid") {
            return <MermaidDiagram source={code} theme={theme} />;
          }

          // Fenced block: language tag, or multiline body (inline code stays a <code> pill).
          if (language || code.includes("\n")) {
            return <CodeBlock language={language || "text"}>{code}</CodeBlock>;
          }

          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
        img({ src = "", alt = "" }) {
          const resolved = resolveMarkdownImage(src, artifactPath);
          if (!resolved) return <span className="text-scout-muted">[blocked image: {alt || "image"}]</span>;
          if (resolved.direct) {
            return <img src={resolved.direct} alt={alt} className="max-w-full rounded-card" />;
          }
          return (
            <AuthenticatedImage
              src={`${baseUrl}${contentEndpoint}?${new URLSearchParams({
                path: resolved.artifact ?? "",
                ...(scope ? { scope } : {}),
              })}`}
              token={token}
              alt={alt}
              className="max-w-full rounded-card"
            />
          );
        },
      }),
    [baseUrl, token, artifactPath, contentEndpoint, scope, theme],
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
});
