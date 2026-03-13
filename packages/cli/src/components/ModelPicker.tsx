/**
 * Arrow-key navigable model selector overlay.
 *
 * Rendered when the user types `/model` without arguments.
 * Up/Down to navigate, Enter to select, Escape to cancel.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "scout-core";

const MAX_VISIBLE = 8;

interface ModelPickerProps {
  models: string[];
  currentModel: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  models,
  currentModel,
  onSelect,
  onCancel,
}) => {
  const initialIdx = Math.max(0, models.indexOf(currentModel));
  const [activeIndex, setActiveIndex] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.upArrow) {
      setActiveIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setActiveIndex((prev) => Math.min(models.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      const selected = models[activeIndex];
      if (selected) onSelect(selected);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  if (models.length === 0) return null;

  let startIdx = 0;
  if (activeIndex >= MAX_VISIBLE) {
    startIdx = activeIndex - MAX_VISIBLE + 1;
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, models.length);
  const visible = models.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text color={theme.text.secondary} italic>
        Select a model (↑↓ navigate, Enter select, Esc cancel):
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {startIdx > 0 && (
          <Text color={theme.text.secondary}>  ▲</Text>
        )}

        {visible.map((m, i) => {
          const realIdx = startIdx + i;
          const isActive = realIdx === activeIndex;
          const isCurrent = m === currentModel;

          return (
            <Box key={m}>
              <Text color={isActive ? theme.text.accent : theme.text.secondary}>
                {isActive ? "❯ " : "  "}
              </Text>
              <Text
                color={isActive ? theme.text.primary : theme.text.secondary}
                bold={isActive}
              >
                {m}
              </Text>
              {isCurrent && (
                <Text color={theme.status.success} dimColor>
                  {" "}(current)
                </Text>
              )}
            </Box>
          );
        })}

        {endIdx < models.length && (
          <Text color={theme.text.secondary}>  ▼</Text>
        )}

        {models.length > MAX_VISIBLE && (
          <Text color={theme.text.secondary} dimColor>
            {"  "}({activeIndex + 1}/{models.length})
          </Text>
        )}
      </Box>
    </Box>
  );
};
