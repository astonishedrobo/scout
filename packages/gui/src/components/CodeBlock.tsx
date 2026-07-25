import { Highlight, type PrismTheme } from "prism-react-renderer";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useState } from "react";

/**
 * Prism theme built entirely from CSS custom properties, so highlighting
 * follows the app theme with no JS involvement. The `--scout-syn-*` palette is
 * deliberately separate from the brand tokens (see globals.css): `soft` — the
 * default theme — desaturates those to near-neutral, which would collapse code
 * back into a single colour.
 */
const scoutPrismTheme: PrismTheme = {
  plain: { color: "rgb(var(--scout-text))", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "cdata"], style: { color: "rgb(var(--scout-syn-comment))", fontStyle: "italic" } },
    { types: ["punctuation"], style: { color: "rgb(var(--scout-syn-punctuation))" } },
    { types: ["keyword", "atrule", "rule", "important", "selector"], style: { color: "rgb(var(--scout-syn-keyword))" } },
    { types: ["string", "char", "attr-value", "regex", "url"], style: { color: "rgb(var(--scout-syn-string))" } },
    { types: ["number", "boolean", "constant", "symbol", "inserted", "unit"], style: { color: "rgb(var(--scout-syn-number))" } },
    { types: ["function", "function-name", "deleted", "tag"], style: { color: "rgb(var(--scout-syn-function))" } },
    { types: ["class-name", "maybe-class-name", "builtin", "namespace"], style: { color: "rgb(var(--scout-syn-type))" } },
    { types: ["operator", "entity", "variable", "property", "attr-name"], style: { color: "rgb(var(--scout-syn-operator))" } },
    { types: ["doctype", "annotation"], style: { color: "rgb(var(--scout-syn-comment))" } },
  ],
};

/** Longer than this and the block collapses; a 500-line output otherwise
 *  pushed the rest of the conversation off screen. */
const COLLAPSE_OVER_LINES = 22;

/** Prism language aliases for the tags people actually type in fences. */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  "c++": "cpp",
  htm: "markup",
  html: "markup",
  xml: "markup",
  text: "plain",
  txt: "plain",
  "": "plain",
};

export function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lineCount = children.split("\n").length;
  const collapsible = lineCount > COLLAPSE_OVER_LINES;

  const handleCopy = useCallback(async () => {
    try {
      // Clipboard writes reject on an insecure origin or a denied permission;
      // this used to fail completely silently.
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2500);
    }
  }, [children]);

  const prismLanguage = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase();

  return (
    <div className="scout-code-block relative my-2 overflow-hidden rounded-card border border-scout-hairline">
      <div className="flex items-center justify-between gap-2 border-b border-scout-hairline bg-scout-panel px-3 py-1.5">
        <span className="font-mono text-caption text-scout-muted">{language || "text"}</span>
        <div className="flex items-center gap-1">
          {copyFailed && (
            <span className="text-micro text-scout-error" role="alert">
              Copy failed
            </span>
          )}
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-micro text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? "Collapse" : `${lineCount} lines`}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            // A 32px box: the old 17px target was below the minimum and had no
            // accessible name at all.
            className="flex h-8 w-8 items-center justify-center rounded-btn text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
            aria-label={copied ? "Copied" : "Copy code"}
            title="Copy code"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>
      <Highlight theme={scoutPrismTheme} code={children} language={prismLanguage}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`m-0 overflow-auto bg-scout-code-bg p-4 font-mono text-[0.8125rem] leading-normal ${
              collapsible && !expanded ? "max-h-[26rem]" : "max-h-[70vh]"
            }`}
          >
            <code>
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line })}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </div>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
      {collapsible && !expanded && (
        // The cap is a real truncation, so say so rather than just clipping.
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-scout-code-bg via-scout-code-bg/85 to-transparent pb-1.5 text-micro font-medium text-scout-muted transition-colors hover:text-scout-text"
        >
          Show all {lineCount} lines
        </button>
      )}
    </div>
  );
}
