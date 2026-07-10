/**
 * Chronological TUI timeline: main prose interleaved with tool-activity groups.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme, STATUS_ICONS } from "scout-core";
import type { ToolStep } from "scout-core";

const MAX_OUTPUT_LINES = 15;
const MAX_ARGS_WIDTH = 60;

interface ActivityLogProps {
  steps: ToolStep[];
  expanded?: boolean;
  width?: number;
}

type TimelineSegment =
  | { kind: "text"; content: string }
  | { kind: "tools"; title: string; steps: ToolStep[] };

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
  if (name === "search_documents") {
    const q = String(args?.query ?? "");
    const p = String(args?.path ?? "");
    return p ? `${q} · ${p}` : q;
  }
  if (name === "read_file") return String(args?.path ?? "");
  if (name === "think") {
    const text = String(args?.content ?? args?.reflection ?? args?.title ?? "");
    return text.substring(0, 80) + (text.length > 80 ? "…" : "");
  }
  if (name === "ask_user_choice") return String(args?.question ?? "");

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

function isThinking(step: ToolStep): boolean {
  return step.kind === "thinking" || step.kind === "reflection" || step.name === "think";
}

function thinkingBody(step: ToolStep): string {
  return (step.reflection ?? step.content ?? "").trim();
}

function deriveToolGroupTitle(tools: ToolStep[]): string {
  if (tools.length === 1) return tools[0]!.name;
  return tools.some((s) => s.status === "executing") ? "Running tools" : "Completed tools";
}

function buildTimeline(steps: ToolStep[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let pendingTitle = "";
  let toolBuffer: ToolStep[] = [];

  const flushTools = () => {
    if (!toolBuffer.length) return;
    segments.push({
      kind: "tools",
      title: pendingTitle || deriveToolGroupTitle(toolBuffer),
      steps: toolBuffer,
    });
    toolBuffer = [];
    pendingTitle = "";
  };

  for (const step of steps) {
    if (isThinking(step)) {
      flushTools();
      const body = thinkingBody(step);
      const title = (step.title ?? "").trim();
      if (body) segments.push({ kind: "text", content: body });
      if (title) pendingTitle = title;
      continue;
    }
    if (step.kind === "text") {
      flushTools();
      const content = (step.content ?? "").trim();
      if (content) segments.push({ kind: "text", content });
      continue;
    }
    toolBuffer.push(step);
  }
  flushTools();
  return segments;
}

function outputLines(output: string): string[] {
  return truncateOutput(output).split("\n");
}

export const ActivityLog: React.FC<ActivityLogProps> = ({
  steps,
  expanded = false,
  width,
}) => {
  if (steps.length === 0) return null;
  const segments = buildTimeline(steps);
  if (segments.length === 0) return null;

  return (
    <Box flexDirection="column" {...(width ? { width } : {})}>
      {segments.map((segment, i) => {
        if (segment.kind === "text") {
          return (
            <Box key={i} flexDirection="column" marginBottom={i === segments.length - 1 ? 0 : 1}>
              <Box>
                <Box width={3} flexShrink={0}>
                  <Text color={theme.text.secondary}>›</Text>
                </Box>
                <Text color={theme.text.primary} wrap="wrap">
                  {segment.content}
                </Text>
              </Box>
            </Box>
          );
        }

        const running = segment.steps.some((s) => s.status === "executing");
        return (
          <Box key={i} flexDirection="column" marginBottom={i === segments.length - 1 ? 0 : 1}>
            <Box>
              <Box width={3} flexShrink={0}>
                {running ? (
                  <Text color={theme.status.active}>
                    <Spinner type="dots" />
                  </Text>
                ) : (
                  <Text color={theme.text.secondary}>◷</Text>
                )}
              </Box>
              <Text color={theme.text.secondary} bold>
                {running ? "Working · " : "Activity · "}
              </Text>
              <Text color={theme.text.secondary} wrap="wrap">
                {segment.title}
              </Text>
            </Box>
            {segment.steps.map((step, j) => (
              <Box key={j} flexDirection="column" marginLeft={3}>
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
            ))}
          </Box>
        );
      })}
    </Box>
  );
};
