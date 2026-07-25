import { useEffect, useMemo, useState } from "react";
import type { BundledLanguage, ThemedToken, ThemeRegistrationRaw } from "shiki";

const HIGHLIGHT_LIMIT = 500_000;

const languages: Record<string, BundledLanguage> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  xml: "xml",
  svg: "xml",
};

export function languageForPath(path: string): BundledLanguage | "text" {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  const parts = name.split(".");
  for (let index = 1; index < parts.length; index++) {
    const match = languages[parts.slice(index).join(".")];
    if (match) return match;
  }
  return languages[parts.at(-1) ?? ""] ?? "text";
}

function rgbToken(style: CSSStyleDeclaration, token: string, fallback: string) {
  const channels = style.getPropertyValue(token).trim();
  return channels ? `rgb(${channels.replaceAll(" ", ", ")})` : fallback;
}

function scoutTheme(mode: "light" | "dark" | "soft"): ThemeRegistrationRaw {
  const style = getComputedStyle(document.documentElement);
  const color = (token: string, fallback: string) => rgbToken(style, token, fallback);
  return {
    name: `scout-${mode}`,
    type: mode === "light" ? "light" : "dark",
    colors: {
      "editor.foreground": color("--scout-text", mode === "light" ? "#17191d" : "#eceef1"),
      "editor.background": "transparent",
    },
    tokenColors: [
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: color("--scout-syn-comment", "#8b9099"), fontStyle: "italic" } },
      { scope: ["keyword", "storage", "storage.type", "storage.modifier"], settings: { foreground: color("--scout-syn-keyword", "#c4a4ff") } },
      { scope: ["string", "string.quoted", "string.template"], settings: { foreground: color("--scout-syn-string", "#7ee787") } },
      { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: color("--scout-syn-number", "#ffab70") } },
      { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: color("--scout-syn-function", "#79b8ff") } },
      { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"], settings: { foreground: color("--scout-syn-type", "#6ee7dd") } },
      { scope: ["keyword.operator", "variable", "variable.other"], settings: { foreground: color("--scout-syn-operator", "#f6c476") } },
      { scope: ["punctuation", "meta.brace"], settings: { foreground: color("--scout-syn-punctuation", "#8f949d") } },
      { scope: ["markup.heading", "entity.name.tag"], settings: { foreground: color("--scout-syn-function", "#79b8ff"), fontStyle: "bold" } },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    ],
  };
}

function currentMode(): "light" | "dark" | "soft" {
  const root = document.documentElement;
  if (root.classList.contains("light")) return "light";
  if (root.classList.contains("soft")) return "soft";
  return "dark";
}

function useThemeMode() {
  const [mode, setMode] = useState(currentMode);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(currentMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

function tokenStyle(token: ThemedToken): React.CSSProperties {
  const style = token.fontStyle ?? 0;
  return {
    color: token.color,
    fontStyle: style & 1 ? "italic" : undefined,
    fontWeight: style & 2 ? 700 : undefined,
    textDecoration: style & 4 ? "underline" : undefined,
  };
}

function PlainLargeSource({ content }: { content: string }) {
  const lineCount = content === "" ? 1 : content.split("\n").length;
  const numbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );
  return (
    <div className="grid min-w-max grid-cols-[auto_1fr] font-mono text-[0.8125rem] leading-6">
      <pre aria-hidden="true" className="sticky left-0 m-0 select-none border-r border-scout-hairline-faint bg-scout-canvas px-3 text-right text-scout-muted/55">{numbers}</pre>
      <pre className="m-0 px-4 text-scout-text">{content}</pre>
    </div>
  );
}

export function SourceViewer({ content, path }: { content: string; path: string }) {
  const mode = useThemeMode();
  const language = languageForPath(path);
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (content.length > HIGHLIGHT_LIMIT || language === "text") {
      setLines(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLines(null);
    setFailed(false);
    void import("shiki")
      .then(({ codeToTokens }) => codeToTokens(content, { lang: language, theme: scoutTheme(mode) }))
      .then((result) => {
        if (!cancelled) setLines(result.tokens);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [content, language, mode]);

  if (content.length > HIGHLIGHT_LIMIT || language === "text" || failed) {
    return <PlainLargeSource content={content} />;
  }

  if (!lines) {
    return <div className="px-4 py-3 font-mono text-caption text-scout-muted">Highlighting source…</div>;
  }

  return (
    <div className="min-w-max font-mono text-[0.8125rem] leading-6">
      {lines.map((line, index) => (
        <div key={index} className="grid min-h-6 grid-cols-[3.75rem_1fr]">
          <span
            aria-hidden="true"
            className="sticky left-0 z-[1] select-none border-r border-scout-hairline-faint bg-scout-canvas pr-3 text-right tabular-nums text-scout-muted/55"
          >
            {index + 1}
          </span>
          <code className="whitespace-pre px-4">
            {line.length === 0
              ? "\n"
              : line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={tokenStyle(token)}>{token.content}</span>
                ))}
          </code>
        </div>
      ))}
    </div>
  );
}
