/**
 * Terminal markdown renderer.
 *
 * Parsing: unified + remark-parse + remark-gfm  (battle-tested AST)
 * Tables:  ANSI-aware column sizing via string-width + wrap-ansi,
 *          multi-line cell support, inspired by Gemini CLI's TableRenderer.
 * Inline:  chalk-based ANSI formatting.
 * Code:    optional cli-highlight syntax coloring.
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type {
  Root,
  RootContent,
  PhrasingContent,
  Table,
  TableRow,
} from "mdast";
import { theme } from "../theme.js";

/* ═══════════════════════════════════════════════════════════════════
   Markdown parser  (created once, reused)
   ═══════════════════════════════════════════════════════════════════ */

const mdParser = unified().use(remarkParse).use(remarkGfm);

/* ═══════════════════════════════════════════════════════════════════
   Optional syntax highlighter
   ═══════════════════════════════════════════════════════════════════ */

let highlightCode: ((code: string, lang: string) => string) | null = null;
try {
  const mod = await import("cli-highlight");
  const hlFn =
    typeof mod.highlight === "function"
      ? mod.highlight
      : typeof (mod as Record<string, unknown>).default === "object" &&
          typeof ((mod as Record<string, unknown>).default as Record<string, unknown>)?.highlight === "function"
        ? ((mod as Record<string, unknown>).default as { highlight: typeof mod.highlight }).highlight
        : null;

  if (hlFn) {
    highlightCode = (code: string, lang: string) => {
      try {
        return hlFn(code, { language: lang || "plaintext" });
      } catch {
        return code;
      }
    };
  }
} catch {
  // cli-highlight not installed
}

/* ═══════════════════════════════════════════════════════════════════
   Public component
   ═══════════════════════════════════════════════════════════════════ */

interface MarkdownTextProps {
  children: string;
  width?: number;
}

export const MarkdownText: React.FC<MarkdownTextProps> = ({
  children,
  width,
}) => {
  const w = width ?? process.stdout.columns ?? 80;
  const elements = useMemo(() => {
    if (!children) return [];
    const tree = mdParser.parse(children);
    return renderRoot(tree, w);
  }, [children, w]);

  return <Box flexDirection="column">{elements}</Box>;
};

/* ═══════════════════════════════════════════════════════════════════
   Block-level rendering  (MDAST → Ink components)
   ═══════════════════════════════════════════════════════════════════ */

function renderRoot(tree: Root, width: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < tree.children.length; i++) {
    const rendered = renderBlock(tree.children[i], width, 0, i);
    if (rendered !== null) nodes.push(rendered);
  }
  return nodes;
}

function renderBlock(
  node: RootContent,
  width: number,
  depth: number,
  key: number | string,
): React.ReactNode {
  switch (node.type) {
    case "heading": {
      const lvl = node.depth;
      const color = lvl <= 2 ? theme.text.link : theme.text.primary;
      return (
        <Box key={key} marginTop={0}>
          <Text
            bold={lvl <= 3}
            italic={lvl >= 4}
            underline={lvl === 1}
            color={color}
            wrap="wrap"
          >
            {renderInline(node.children, color)}
          </Text>
        </Box>
      );
    }

    case "paragraph":
      return (
        <Box key={key}>
          <Text wrap="wrap" color={theme.text.primary}>
            {renderInline(node.children, theme.text.primary)}
          </Text>
        </Box>
      );

    case "code":
      return renderCodeBlock(node.value, node.lang ?? "", width, key);

    case "blockquote":
      return (
        <Box key={key} flexDirection="row" paddingLeft={1}>
          <Box width={2} flexShrink={0}>
            <Text color={theme.text.accent}>│</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} flexDirection="column">
            {node.children.map((child, i) =>
              renderBlock(child, width - 4, depth + 1, `${key}-bq-${i}`),
            )}
          </Box>
        </Box>
      );

    case "list": {
      const ordered = node.ordered ?? false;
      const start = node.start ?? 1;
      return (
        <Box key={key} flexDirection="column">
          {node.children.map((item, i) => {
            const marker = ordered
              ? `${start + i}.`
              : depth === 0 ? "•" : depth === 1 ? "◦" : "▪";
            const mw = marker.length + 1;
            return (
              <Box key={`${key}-li-${i}`} paddingLeft={1} flexDirection="row">
                <Box width={mw} flexShrink={0}>
                  <Text color={theme.text.primary}>{marker}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} flexDirection="column">
                  {item.children.map((child, j) =>
                    renderBlock(
                      child as RootContent,
                      width - mw - 2,
                      depth + 1,
                      `${key}-li-${i}-${j}`,
                    ),
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }

    case "thematicBreak":
      return (
        <Box key={key} marginY={0}>
          <Text color={theme.border.default}>
            {"─".repeat(Math.min(width - 2, 60))}
          </Text>
        </Box>
      );

    case "table":
      return <MdTable key={key} node={node} width={width} />;

    case "html":
      if (node.value.includes("<br")) return <Box key={key} height={1} />;
      return null;

    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Inline rendering  (MDAST PhrasingContent → chalk ANSI string)
   ═══════════════════════════════════════════════════════════════════ */

function renderInline(nodes: PhrasingContent[], baseColor: string): string {
  let result = "";
  for (const node of nodes) result += renderInlineNode(node, baseColor);
  return result;
}

function renderInlineNode(node: PhrasingContent, baseColor: string): string {
  switch (node.type) {
    case "text":
      return chalk.hex(baseColor)(node.value);
    case "strong":
      return chalk.bold(renderInline(node.children, baseColor));
    case "emphasis":
      return chalk.italic(renderInline(node.children, baseColor));
    case "delete":
      return chalk.strikethrough(renderInline(node.children, baseColor));
    case "inlineCode":
      return chalk.hex(theme.text.accent)(node.value);
    case "link": {
      const linkText = renderInline(node.children, baseColor);
      const url = chalk.hex(theme.text.link).underline(node.url);
      return `${linkText} (${url})`;
    }
    case "image":
      return chalk.hex(theme.text.secondary)(`[image: ${node.alt || node.url}]`);
    case "break":
      return "\n";
    case "html":
      if (node.value.startsWith("<br")) return "\n";
      return "";
    default:
      return "";
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Code block  (bordered panel, optional syntax highlighting)
   ═══════════════════════════════════════════════════════════════════ */

function renderCodeBlock(
  code: string,
  lang: string,
  width: number,
  key: number | string,
): React.ReactNode {
  const codeWidth = Math.min(width - 2, 120);
  const innerW = codeWidth - 2;
  const bc = chalk.hex(theme.border.default);
  const langLabel = lang ? ` ${lang} ` : "";
  const topBarLen = Math.max(0, innerW - langLabel.length);
  const topLine =
    bc("╭") +
    bc("─".repeat(Math.floor(topBarLen / 2))) +
    chalk.hex(theme.text.secondary)(langLabel) +
    bc("─".repeat(Math.ceil(topBarLen / 2))) +
    bc("╮");
  const botLine = bc("╰" + "─".repeat(innerW) + "╯");

  const highlighted = highlightCode ? highlightCode(code, lang) : code;
  const lines = highlighted.split("\n");
  const codeColor = chalk.hex("#C8C8C8");
  const maxContentW = innerW - 2;

  const renderedLines = lines.map((line) => {
    const vw = stringWidth(line);
    let displayLine = line;
    if (vw > maxContentW) {
      displayLine = truncateAnsi(line, maxContentW - 1) + "…";
    }
    const displayW = stringWidth(displayLine);
    const padLen = Math.max(0, maxContentW - displayW);
    const hasAnsi = /\x1b\[/.test(displayLine);
    const content = hasAnsi ? displayLine : codeColor(displayLine);
    return bc("│") + " " + content + " ".repeat(padLen) + " " + bc("│");
  });

  if (renderedLines.length === 0) {
    renderedLines.push(bc("│") + " ".repeat(innerW) + bc("│"));
  }

  return (
    <Box key={key} flexDirection="column" marginY={1} paddingLeft={1}>
      <Text>{topLine}</Text>
      {renderedLines.map((rl, j) => (
        <Text key={j}>{rl}</Text>
      ))}
      <Text>{botLine}</Text>
    </Box>
  );
}

/** Truncate an ANSI string to `maxWidth` visible characters. */
function truncateAnsi(str: string, maxWidth: number): string {
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < maxWidth) {
    if (str[i] === "\x1b") {
      const end = str.indexOf("m", i);
      if (end !== -1) { i = end + 1; continue; }
    }
    visible++;
    i++;
  }
  return str.slice(0, i) + "\x1b[0m";
}

/* ═══════════════════════════════════════════════════════════════════
   Table renderer  (GFM table → box-drawing bordered, multi-line cells)
   ═══════════════════════════════════════════════════════════════════

   Approach (inspired by Gemini CLI's TableRenderer):
   1. Render each cell's inline markdown to a chalk ANSI string
   2. Flatten <br>/newlines in source into actual newlines
   3. Calculate per-column min-width (longest word) and max-width (unwrapped)
   4. Allocate column widths proportionally within the terminal budget
   5. Wrap each cell to its column width using wrap-ansi
   6. Render row-by-row, handling multi-line cells
   ═══════════════════════════════════════════════════════════════════ */

const COL_PAD = 1; // spaces of padding each side inside │

interface MdTableProps {
  node: Table;
  width: number;
}

const MdTable: React.FC<MdTableProps> = ({ node, width }) => {
  if (node.children.length === 0) return null;

  const headerRow: TableRow = node.children[0];
  const dataRows: TableRow[] = node.children.slice(1);
  const numCols = headerRow.children.length;

  // 1. Render cell content to ANSI strings, normalizing newlines
  const fmtCell = (cell: TableRow["children"][number], color: string) => {
    const raw = renderInline(cell.children as PhrasingContent[], color);
    // Normalize: <br> tags that survived inline rendering become \n
    return raw.replace(/<br\s*\/?>/gi, "\n");
  };

  const fmtHeaders = headerRow.children.map((c) => fmtCell(c, theme.text.link));
  const fmtRows = dataRows.map((row) =>
    row.children.map((c) => fmtCell(c, theme.text.primary)),
  );

  // 2. Calculate column constraints: minWidth (longest single word) and maxWidth (full unwrapped)
  const constraints = Array.from({ length: numCols }, (_, ci) => {
    let maxContentWidth = cellMaxLineWidth(fmtHeaders[ci] ?? "");
    let maxWordWidth = cellMaxWordWidth(fmtHeaders[ci] ?? "");

    for (const r of fmtRows) {
      const cell = r[ci] ?? "";
      maxContentWidth = Math.max(maxContentWidth, cellMaxLineWidth(cell));
      maxWordWidth = Math.max(maxWordWidth, cellMaxWordWidth(cell));
    }

    return {
      minWidth: Math.max(3, maxWordWidth),
      maxWidth: Math.max(3, maxContentWidth),
    };
  });

  // 3. Allocate widths
  const fixedOverhead = (numCols + 1) + numCols * COL_PAD * 2; // borders + padding
  const available = Math.max(0, width - fixedOverhead - 2); // 2 for outer margin

  const totalMin = constraints.reduce((s, c) => s + c.minWidth, 0);
  let colWidths: number[];

  if (totalMin > available) {
    // Must scale down — proportional to minWidth
    const scale = available / totalMin || 0;
    colWidths = constraints.map((c) => Math.max(3, Math.floor(c.minWidth * scale)));
  } else {
    // Distribute surplus proportionally to growth need
    const surplus = available - totalMin;
    const totalGrowth = constraints.reduce((s, c) => s + (c.maxWidth - c.minWidth), 0);

    if (totalGrowth === 0) {
      colWidths = constraints.map((c) => c.minWidth);
    } else {
      colWidths = constraints.map((c) => {
        const growthNeed = c.maxWidth - c.minWidth;
        const extra = Math.floor(surplus * (growthNeed / totalGrowth));
        return Math.min(c.maxWidth, c.minWidth + extra);
      });
    }
  }

  // 4. Wrap cells and render
  const wrapCell = (text: string, colW: number): string[] => {
    if (!text) return [""];
    const wrapped = wrapAnsi(text, colW, { hard: true, trim: false });
    return wrapped.split("\n");
  };

  const bc = (s: string) => chalk.hex(theme.border.default)(s);

  const borderLine = (l: string, mid: string, r: string, h: string) =>
    bc(l + colWidths.map((w) => h.repeat(w + COL_PAD * 2)).join(mid) + r);

  const renderRow = (cells: string[], isHeader: boolean, rowKey: string): React.ReactNode[] => {
    // Wrap each cell
    const wrappedCells = cells.map((cell, ci) => wrapCell(cell, colWidths[ci]));
    const maxHeight = Math.max(...wrappedCells.map((lines) => lines.length), 1);

    const visualRows: React.ReactNode[] = [];
    for (let lineIdx = 0; lineIdx < maxHeight; lineIdx++) {
      const rowStr = bc("│") +
        colWidths.map((w, ci) => {
          const line = wrappedCells[ci][lineIdx] ?? "";
          const vw = stringWidth(line);
          const pad = Math.max(0, w - vw);
          const content = isHeader ? chalk.bold(line) : line;
          return " " + content + " ".repeat(pad) + " ";
        }).join(bc("│")) +
        bc("│");
      visualRows.push(<Text key={`${rowKey}-${lineIdx}`}>{rowStr}</Text>);
    }
    return visualRows;
  };

  const tableLines: React.ReactNode[] = [];
  // Top border
  tableLines.push(<Text key="top">{borderLine("┌", "┬", "┐", "─")}</Text>);
  // Header
  tableLines.push(...renderRow(fmtHeaders, true, "hdr"));
  // Middle border
  tableLines.push(<Text key="mid">{borderLine("├", "┼", "┤", "─")}</Text>);
  // Data rows
  fmtRows.forEach((row, ri) => {
    tableLines.push(...renderRow(row, false, `r${ri}`));
  });
  // Bottom border
  tableLines.push(<Text key="bot">{borderLine("└", "┴", "┘", "─")}</Text>);

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      {tableLines}
    </Box>
  );
};

/** Max visual width of any single line in a (possibly multi-line) ANSI string. */
function cellMaxLineWidth(cell: string): number {
  if (!cell) return 0;
  return Math.max(...cell.split("\n").map((l) => stringWidth(l)));
}

/** Max visual width of any single word (whitespace-split) in a cell. */
function cellMaxWordWidth(cell: string): number {
  if (!cell) return 0;
  const plain = cell.replace(/\x1b\[[0-9;]*m/g, "");
  const words = plain.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return Math.max(...words.map((w) => stringWidth(w)));
}
