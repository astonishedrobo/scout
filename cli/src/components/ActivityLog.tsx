/**
 * Integrated activity timeline: concise public reflections plus tool steps.
 *
 * Reflections are always visible. Tool output previews are shown when expanded.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolStep } from "../types.js";
import { theme, STATUS_ICONS } from "../theme.js";

/* ── Constants ───────────────────────────────────────────────────── */

const MAX_OUTPUT_LINES = 15;
const MAX_ARGS_WIDTH = 60;

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

  if (name === "run_node" || name === "exec_command") {
    const desc = String(args?.description ?? "").trim();
    if (desc) return desc.substring(0, MAX_ARGS_WIDTH);
    if (name === "exec_command") return String(args?.cmd ?? "").substring(0, MAX_ARGS_WIDTH);
    const code = String(args?.code ?? "").split("\n");
    let s = code[0]?.substring(0, MAX_ARGS_WIDTH) ?? "";
    if (code.length > 1 || (code[0]?.length ?? 0) > MAX_ARGS_WIDTH) s += "…";
    return s;
  }
  if (name === "search_workspace" || name === "filter_table") {
    const q = String(args?.query ?? "");
    const p = String(args?.path ?? "");
    return p ? `${q} · ${p}` : q;
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

function reflectionText(step: ToolStep): string {
  return (step.reflection ?? step.output ?? "").trim();
}

function outputLines(output: string): string[] {
  return truncateOutput(output).split("\n");
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
      {...(width ? { width } : {})}
    >
      {steps.map((step, i) => {
        if (step.kind === "reflection") {
          return (
            <Box key={i} flexDirection="column" marginBottom={i === steps.length - 1 ? 0 : 1}>
              <Box>
                <Box width={3} flexShrink={0}>
                  <Text color={theme.text.secondary}>◷</Text>
                </Box>
                <Text color={theme.text.secondary} italic wrap="wrap">
                  {reflectionText(step)}
                </Text>
              </Box>
              <Box>
                <Box width={3} flexShrink={0}>
                  <Text color={theme.status.success}>{STATUS_ICONS.complete}</Text>
                </Box>
                <Text color={theme.text.secondary}>Done</Text>
              </Box>
            </Box>
          );
        }

        return (
          <Box key={i} flexDirection="column" marginBottom={i === steps.length - 1 ? 0 : 1}>
            <Box>
              <Box width={3} flexShrink={0}>
                {step.status === "executing" ? (
                  <Text color={theme.status.active}>
                    <Spinner type="dots" />
                  </Text>
                ) : (
                  <Text color={theme.text.secondary}>◎</Text>
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

            {expanded && step.status === "complete" && step.output && (
              <Box flexDirection="column">
                {outputLines(step.output).map((line, lineIndex) => (
                  <Box key={lineIndex}>
                    <Box width={3} flexShrink={0}>
                      <Text color={theme.text.secondary}>│</Text>
                    </Box>
                    <Text color={theme.tool.output} dimColor wrap="wrap">
                      {line}
                    </Text>
                  </Box>
                ))}
              </Box>
            )}

            {step.status === "complete" && (
              <Box>
                <Box width={3} flexShrink={0}>
                  <Text color={theme.status.success}>{STATUS_ICONS.complete}</Text>
                </Box>
                <Text color={theme.text.secondary}>Done</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
