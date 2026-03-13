/**
 * Conversation history — Gemini-style layout.
 *
 *   > user message
 *
 *   ╭─────────────────────────────────╮
 *   │ ✓ run_code  import pandas …    │
 *   │ ✓ search_documents  climate …  │
 *   ╰─────────────────────────────────╯
 *   3 tool steps — press Tab to expand
 *   ✦ Assistant response in markdown…
 *
 * Live streaming steps + spinner are rendered dynamically at the bottom.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { ActivityLog } from "./ActivityLog.js";
import { MarkdownText } from "./MarkdownText.js";
import { theme } from "../theme.js";
import type { ToolStep } from "../types.js";

/* ── Types ───────────────────────────────────────────────────────── */

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Completed tool steps (populated after streaming ends). */
  steps?: ToolStep[];
}

interface MessageListProps {
  messages: Message[];
  /** Live steps for the response currently being streamed. */
  streamingSteps: ToolStep[];
  /** Whether the agent is currently loading (for streaming indicator). */
  isLoading?: boolean;
  /** Current tool being executed. */
  currentTool?: string;
  /** Index of the assistant message whose tool output is expanded. */
  expandedIndex: number | null;
  /** Terminal width for responsive layout. */
  width?: number;
}

/* ── Prefix widths ───────────────────────────────────────────────── */

const PREFIX_WIDTH = 2; // "> " or "✦ "

/* ── Component ───────────────────────────────────────────────────── */

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingSteps,
  isLoading = false,
  currentTool,
  expandedIndex,
  width,
}) => {
  const termWidth = width ?? (process.stdout.columns || 80);
  const contentWidth = Math.max(termWidth - PREFIX_WIDTH - 2, 20);

  return (
    <Box flexDirection="column" width={termWidth}>
      {/* ── Conversation history ─────────────────────────────── */}
      {/* NOTE: We deliberately do NOT use Ink's <Static> here    */}
      {/* because the Tab expand/collapse feature requires these  */}
      {/* items to re-render when expandedIndex changes.          */}
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {msg.role === "user" ? (
            /* ── User message ─────────────────────────── */
            <Box paddingLeft={1}>
              <Box width={PREFIX_WIDTH} flexShrink={0}>
                <Text color={theme.text.accent}>{">"}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={theme.text.user} wrap="wrap">
                  {msg.content}
                </Text>
              </Box>
            </Box>
          ) : (
            /* ── Assistant message ────────────────────── */
            <Box flexDirection="column">
              {/* Tool steps (collapsed by default) */}
              {msg.steps && msg.steps.length > 0 && (
                <Box paddingLeft={1} marginBottom={0}>
                  <ActivityLog
                    steps={msg.steps}
                    expanded={expandedIndex === i}
                    width={termWidth - 2}
                  />
                </Box>
              )}

              {/* Toggle hint */}
              {msg.steps && msg.steps.length > 0 && (
                <Box paddingLeft={PREFIX_WIDTH + 2}>
                  <Text color={theme.text.secondary} dimColor>
                    {expandedIndex === i
                      ? "press Tab to collapse"
                      : `${msg.steps.length} tool step${msg.steps.length > 1 ? "s" : ""} — press Tab to expand`}
                  </Text>
                </Box>
              )}

              {/* Response text */}
              <Box paddingLeft={1} marginTop={msg.steps && msg.steps.length > 0 ? 1 : 0}>
                <Box width={PREFIX_WIDTH} flexShrink={0}>
                  <Text color={theme.text.accent}>{"✦"}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <MarkdownText width={contentWidth}>{msg.content}</MarkdownText>
                </Box>
              </Box>
            </Box>
          )}
        </Box>
      ))}

      {/* ── Live streaming section ───────────────────────────── */}
      {/* Show during loading: streaming tool steps + spinner    */}
      {isLoading && (
        <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
          {/* Tool steps box (if any tool calls have arrived) */}
          {streamingSteps.length > 0 && (
            <Box marginBottom={0}>
              <ActivityLog
                steps={streamingSteps}
                expanded={true}
                width={termWidth - 2}
              />
            </Box>
          )}

          {/* Spinner / thinking indicator */}
          <Box paddingLeft={1} marginTop={streamingSteps.length > 0 ? 0 : 0}>
            <Box width={2} flexShrink={0}>
              <Text color={theme.ui.spinner}>
                <Spinner type="dots" />
              </Text>
            </Box>
            <Text color={theme.text.primary} italic>
              {currentTool ? `Running ${currentTool}` : "Thinking"}…
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
