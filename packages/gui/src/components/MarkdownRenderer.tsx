import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { useTheme } from "../hooks/useTheme";
import { AuthenticatedImage } from "./AuthenticatedImage";

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

function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  return (
    <div className="scout-code-block relative group my-2 rounded-card overflow-hidden border border-scout-hairline">
      <div className="flex items-center justify-between px-3 py-1.5 bg-scout-panel border-b border-scout-hairline">
        <span className="text-xs text-scout-muted font-mono">{language || "text"}</span>
        <button
          onClick={handleCopy}
          className="text-scout-muted hover:text-scout-text transition-colors p-0.5"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre className="m-0 p-4 bg-scout-code-bg text-scout-text text-[0.8125rem] leading-normal font-mono overflow-x-auto">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function MermaidDiagram({ source, theme }: { source: string; theme: "light" | "dark" | "soft" }) {
  const [svg, setSvg] = useState(() => mermaidCache.get(source) ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (!mermaidModule) {
      mermaidModule = import("mermaid").then((module) => {
        module.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "light" ? "neutral" : "dark",
        });
        return module;
      });
    }
    mermaidModule
      .then(({ default: mermaid }) => {
        const cached = mermaidCache.get(source);
        return cached ? { svg: cached } : mermaid.render(`mermaid-${hashSource(source)}`, source);
      })
      .then(({ svg }) => {
        mermaidCache.set(source, svg);
        if (active) setSvg(svg);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [source, theme]);
  if (error) return <pre className="text-xs text-scout-error whitespace-pre-wrap">{error}</pre>;
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

export function MarkdownRenderer({
  content,
  baseUrl = "",
  token = null,
  artifactPath = "",
  contentEndpoint = "/artifacts/content",
  scope = null,
}: MarkdownRendererProps) {
  const { theme } = useTheme();

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
