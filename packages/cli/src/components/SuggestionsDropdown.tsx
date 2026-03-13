/**
 * Generic suggestion dropdown for autocomplete.
 *
 * Used by both @ file completion and / slash command completion.
 * Clean style — no border box, just indented rows.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "scout-core";
import type { Suggestion } from "scout-core";

const MAX_VISIBLE = 8;

interface SuggestionsDropdownProps {
  suggestions: Suggestion[];
  activeIndex: number;
  /** "file" shows labels only; "command" adds a description column. */
  mode: "file" | "command";
}

export const SuggestionsDropdown: React.FC<SuggestionsDropdownProps> = ({
  suggestions,
  activeIndex,
  mode,
}) => {
  if (suggestions.length === 0) return null;

  let startIdx = 0;
  if (activeIndex >= MAX_VISIBLE) {
    startIdx = activeIndex - MAX_VISIBLE + 1;
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, suggestions.length);
  const visible = suggestions.slice(startIdx, endIdx);

  const maxLabelLen =
    mode === "command"
      ? Math.max(...suggestions.map((s) => s.label.length), 10)
      : 0;

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={0}>
      {startIdx > 0 && (
        <Text color={theme.text.secondary}>  ▲</Text>
      )}

      {visible.map((s, i) => {
        const realIdx = startIdx + i;
        const isActive = realIdx === activeIndex;

        return (
          <Box key={`${s.value}-${realIdx}`}>
            <Text color={isActive ? theme.text.accent : theme.text.secondary}>
              {isActive ? "❯ " : "  "}
            </Text>
            <Text
              color={isActive ? theme.text.primary : theme.text.secondary}
              bold={isActive}
            >
              {s.label}
            </Text>
            {mode === "command" && s.description && (
              <Text color={theme.text.secondary} dimColor>
                {" ".repeat(Math.max(1, maxLabelLen - s.label.length + 2))}
                {s.description}
              </Text>
            )}
          </Box>
        );
      })}

      {endIdx < suggestions.length && (
        <Text color={theme.text.secondary}>  ▼</Text>
      )}

      {suggestions.length > MAX_VISIBLE && (
        <Text color={theme.text.secondary} dimColor>
          {"  "}({activeIndex + 1}/{suggestions.length})
        </Text>
      )}
    </Box>
  );
};
