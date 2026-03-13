/**
 * Arrow-key navigable Python environment selector overlay.
 *
 * Shown during /init to let the user pick a conda env, local venv,
 * or system Python for the agent's code execution session.
 * Up/Down to navigate, Enter to select, Escape to skip.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import type { EnvOption } from "../envDetect.js";

const MAX_VISIBLE = 8;

interface EnvPickerProps {
  envs: EnvOption[];
  onSelect: (env: EnvOption) => void;
  onCancel: () => void;
}

export const EnvPicker: React.FC<EnvPickerProps> = ({
  envs,
  onSelect,
  onCancel,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setActiveIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setActiveIndex((prev) => Math.min(envs.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      const selected = envs[activeIndex];
      if (selected) onSelect(selected);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  if (envs.length === 0) return null;

  let startIdx = 0;
  if (activeIndex >= MAX_VISIBLE) {
    startIdx = activeIndex - MAX_VISIBLE + 1;
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, envs.length);
  const visible = envs.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text color={theme.text.secondary} italic>
        Select a Python environment for code execution (↑↓ navigate, Enter select, Esc skip):
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {startIdx > 0 && (
          <Text color={theme.text.secondary}>  ▲</Text>
        )}

        {visible.map((env, i) => {
          const realIdx = startIdx + i;
          const isActive = realIdx === activeIndex;

          return (
            <Box key={`${env.value}-${realIdx}`}>
              <Text color={isActive ? theme.text.accent : theme.text.secondary}>
                {isActive ? "❯ " : "  "}
              </Text>
              <Text
                color={isActive ? theme.text.primary : theme.text.secondary}
                bold={isActive}
              >
                {env.label}
              </Text>
              {env.type !== "system" && (
                <Text color={theme.text.secondary} dimColor>
                  {"  "}{env.type === "venv" ? env.value : ""}
                </Text>
              )}
            </Box>
          );
        })}

        {endIdx < envs.length && (
          <Text color={theme.text.secondary}>  ▼</Text>
        )}

        {envs.length > MAX_VISIBLE && (
          <Text color={theme.text.secondary} dimColor>
            {"  "}({activeIndex + 1}/{envs.length})
          </Text>
        )}
      </Box>
    </Box>
  );
};
