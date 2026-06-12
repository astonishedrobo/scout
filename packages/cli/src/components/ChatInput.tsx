/**
 * Chat input — Gemini-style, no border, full terminal width.
 *
 * Layout:
 *   ────────────────────────────────  (thin separator)
 *   > user types here…
 *
 * Autocomplete dropdowns appear above the separator.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { SuggestionsDropdown } from "./SuggestionsDropdown.js";
import { useFileCompletion } from "../hooks/useFileCompletion.js";
import { useSlashCompletion } from "../hooks/useSlashCompletion.js";
import { theme, separator } from "scout-core";

interface ChatInputProps {
  onSubmit: (message: string) => void;
  disabled: boolean;
  cwd?: string;
  /** Terminal width for responsive layout. */
  width?: number;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSubmit,
  disabled,
  cwd,
  width,
}) => {
  const [value, setValue] = useState("");

  const fileSuggestions = useFileCompletion(value, cwd);
  const slashSuggestions = useSlashCompletion(value);

  // Determine which completion mode is active
  const active = fileSuggestions.isActive
    ? fileSuggestions
    : slashSuggestions.isActive
      ? slashSuggestions
      : null;

  const dropdownMode = fileSuggestions.isActive
    ? ("file" as const)
    : ("command" as const);

  // ── Key interceptor ──────────────────────────────────────────────
  useInput(
    (_input, key) => {
      if (disabled) return;
      if (!active) return;

      if (key.upArrow) { active.navigateUp(); return; }
      if (key.downArrow) { active.navigateDown(); return; }
      if (key.tab) {
        if (fileSuggestions.isActive) {
          const accepted = fileSuggestions.accept();
          if (accepted) {
            setValue(value.replace(/@[^\s]*$/, `@${accepted} `));
          }
        } else if (slashSuggestions.isActive) {
          const accepted = slashSuggestions.accept();
          if (accepted) setValue(accepted + " ");
        }
        return;
      }
      if (key.escape) { active.dismiss(); return; }
    },
    { isActive: !disabled },
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      // Accept suggestion on Enter when dropdown is visible
      if (active && active.suggestions.length > 0) {
        if (fileSuggestions.isActive) {
          const accepted = fileSuggestions.accept();
          if (accepted) {
            setValue(value.replace(/@[^\s]*$/, `@${accepted} `));
            return;
          }
        } else if (slashSuggestions.isActive) {
          const accepted = slashSuggestions.accept();
          if (accepted) { setValue(accepted + " "); return; }
        }
      }

      onSubmit(text.trim());
      setValue("");
    },
    [onSubmit, active, fileSuggestions, slashSuggestions, value],
  );

  const termWidth = width ?? (process.stdout.columns || 80);
  const imageRefs = [...value.matchAll(/@([^\s]+\.(?:png|jpe?g|webp|gif))/gi)].map((m) => m[1]!);

  return (
    <Box flexDirection="column" width={termWidth}>
      {/* Suggestions dropdown (shown above the separator) */}
      {active && active.suggestions.length > 0 && (
        <SuggestionsDropdown
          suggestions={active.suggestions}
          activeIndex={active.activeIndex}
          mode={dropdownMode}
        />
      )}

      {/* Thin separator line — full width */}
      <Text color={theme.border.default}>{separator(termWidth)}</Text>

      {imageRefs.length > 0 && (
        <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
          <Text color={theme.text.secondary} bold>Images</Text>
          {imageRefs.map((path, index) => (
            <Text key={`${path}-${index}`} color={theme.text.secondary}>
              {"  "}[{index + 1}] {path}
            </Text>
          ))}
        </Box>
      )}

      {/* Input line */}
      <Box paddingLeft={1}>
        <Text color={theme.text.accent} bold>
          {"❯ "}
        </Text>
        {disabled ? (
          <Text color={theme.text.secondary} dimColor>
            Waiting for response…
          </Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder="Ask about your data… (@ files, / commands)"
          />
        )}
      </Box>
    </Box>
  );
};
