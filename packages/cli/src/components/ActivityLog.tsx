/**
 * Bordered tool-step group — Gemini ToolGroupMessage style.
 *
 * Each step is a compact one-liner:
 *   ✓  run_code  import pandas as pd…
 *
 * Collapsed by default; pass `expanded={true}` to reveal
 * truncated output for completed steps.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme, STATUS_ICONS } from "scout-core";
import type { ToolStep } from "scout-core";

/* ── Constants ───────────────────────────────────────────────────── */

const MAX_OUTPUT_LINES = 15;
const MAX_ARGS_WIDTH = 60;
const TOOL_PADDING_X = 1;

/* ── Props ───────────────────────────────────────────────────────── */

interface ActivityLogProps {
  steps: ToolStep[];
  /** When true, show truncated output for completed steps. */
  expanded?: boolean;
  /** Available width for the tool group box. */
  width?: number;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function summarize(step: ToolStep): string {
  const { name, args } = step;

  if (name === "run_code") {
    const desc = String(args?.description ?? "").trim();
    if (desc) return desc.substring(0, MAX_ARGS_WIDTH);
    const code = String(args?.code ?? "").split("\n");
    let s = code[0]?.substring(0, MAX_ARGS_WIDTH) ?? "";
    if (code.length > 1 || (code[0]?.length ?? 0) > MAX_ARGS_WIDTH) s += "…";
    return s;
  }
  if (name === "search_documents") return String(args?.query ?? "");
  if (name === "read_pdf") {
    let s = String(args?.path ?? "");
    if (args?.query) s += ` → "${args.query}"`;
    return s;
  }
  if (name === "read_file") return String(args?.path ?? "");
  if (name === "think") {
    const text = String(args?.reflection ?? "");
    return text.substring(0, 80) + (text.length > 80 ? "…" : "");
  }
  if (name === "ask_human") return String(args?.question ?? "");

  const raw = JSON.stringify(args ?? {});
  return raw.length > MAX_ARGS_WIDTH
    ? raw.substring(0, MAX_ARGS_WIDTH) + "…"
    : raw;
}

function truncateOutput(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= MAX_OUTPUT_LINES) return output;
  const shown = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  const hidden = lines.length - MAX_OUTPUT_LINES;
  return `${shown}\n  … (${hidden} more lines)`;
}

/* ── Component ───────────────────────────────────────────────────── */

export const ActivityLog: React.FC<ActivityLogProps> = ({
  steps,
  expanded = false,
  width,
}) => {
  if (steps.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={TOOL_PADDING_X}
      {...(width ? { width } : {})}
    >
      {steps.map((step, i) => (
        <Box key={i} flexDirection="column">
          {/* ── Header: icon + name + args ────────────────── */}
          <Box>
            <Box width={2} flexShrink={0}>
              {step.status === "executing" ? (
                <Text color={theme.status.active}>
                  <Spinner type="dots" />
                </Text>
              ) : step.status === "complete" ? (
                <Text color={theme.status.success}>
                  {STATUS_ICONS.complete}
                </Text>
              ) : (
                <Text color={theme.status.error}>
                  {STATUS_ICONS.error}
                </Text>
              )}
            </Box>
            <Text color={theme.tool.name} bold>
              {step.name}
            </Text>
            <Text color={theme.tool.args}>
              {" "}
              {summarize(step)}
            </Text>
          </Box>

          {/* ── Expanded output ───────────────────────────── */}
          {expanded && step.status === "complete" && step.output && (
            <Box paddingLeft={3}>
              <Text color={theme.tool.output} dimColor>
                {truncateOutput(step.output)}
              </Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
};
