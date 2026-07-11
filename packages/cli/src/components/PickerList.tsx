/**
 * Shared arrow-key picker overlay used by all CLI selectors.
 *
 * One visual system across /model, /resume, env and editor pickers —
 * rounded panel, ▸ marker, dim metadata, accent-keyed footer hints —
 * matching the scout deploy wizard.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "scout-core/theme";

const MAX_VISIBLE = 8;

export interface PickerItem {
  /** Stable key + display text. */
  label: string;
  /** Dim metadata rendered after the label. */
  detail?: string;
  /** Trailing badge, e.g. "current" (rendered in success color). */
  badge?: string;
  /** Grayed out and skipped while navigating. */
  disabled?: boolean;
}

export const PickerHints: React.FC<{ hints: [string, string][] }> = ({ hints }) => (
  <Box>
    {hints.map(([keys, label], index) => (
      <Text key={keys}>
        {index > 0 && <Text color={theme.brand.frame}> · </Text>}
        <Text color={theme.text.accent}>{keys}</Text>
        <Text color={theme.text.secondary}> {label}</Text>
      </Text>
    ))}
  </Box>
);

interface PickerListProps {
  title: string;
  items: PickerItem[];
  initialIndex?: number;
  /** Accent for the selection marker and panel border. */
  accent?: string;
  /** Extra footer hint replacing the default "esc cancel" label. */
  escLabel?: string;
  onSelect: (index: number) => void;
  onCancel: () => void;
}

export const PickerList: React.FC<PickerListProps> = ({
  title,
  items,
  initialIndex = 0,
  accent = theme.text.accent,
  escLabel = "cancel",
  onSelect,
  onCancel,
}) => {
  const firstEnabled = items.findIndex((item) => !item.disabled);
  const [activeIndex, setActiveIndex] = useState(
    initialIndex >= 0 && initialIndex < items.length && !items[initialIndex]?.disabled
      ? initialIndex
      : Math.max(0, firstEnabled),
  );

  const move = (direction: 1 | -1) =>
    setActiveIndex((prev) => {
      let next = prev + direction;
      while (next >= 0 && next < items.length && items[next]!.disabled) next += direction;
      return next >= 0 && next < items.length ? next : prev;
    });

  useInput((_input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow || key.tab) move(1);
    else if (key.return) {
      const item = items[activeIndex];
      if (item && !item.disabled) onSelect(activeIndex);
    } else if (key.escape) onCancel();
  });

  if (items.length === 0) return null;

  let startIdx = 0;
  if (activeIndex >= MAX_VISIBLE) startIdx = activeIndex - MAX_VISIBLE + 1;
  const endIdx = Math.min(startIdx + MAX_VISIBLE, items.length);
  const visible = items.slice(startIdx, endIdx);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand.frame}
      paddingX={2}
      paddingY={1}
      marginLeft={2}
      marginBottom={1}
      alignSelf="flex-start"
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text color={theme.text.primary} bold>
          {title}
        </Text>
        {items.length > MAX_VISIBLE && (
          <Text color={theme.text.secondary}>
            {"  "}
            {activeIndex + 1}/{items.length}
          </Text>
        )}
      </Box>

      {startIdx > 0 && <Text color={theme.brand.frame}>  ▲ more</Text>}

      {visible.map((item, i) => {
        const realIdx = startIdx + i;
        const isActive = realIdx === activeIndex;
        return (
          <Box key={`${item.label}-${realIdx}`}>
            <Text color={isActive ? accent : theme.brand.frame}>{isActive ? "▸ " : "  "}</Text>
            <Text
              color={item.disabled ? theme.brand.frame : isActive ? theme.text.primary : theme.text.secondary}
              bold={isActive && !item.disabled}
            >
              {item.label}
            </Text>
            {item.detail && (
              <Text color={isActive ? theme.text.secondary : theme.brand.frame}>  {item.detail}</Text>
            )}
            {item.badge && <Text color={theme.status.success}>  {item.badge}</Text>}
          </Box>
        );
      })}

      {endIdx < items.length && <Text color={theme.brand.frame}>  ▼ more</Text>}

      <Box marginTop={1}>
        <PickerHints
          hints={[
            ["↑/↓", "select"],
            ["↵", "confirm"],
            ["esc", escLabel],
          ]}
        />
      </Box>
    </Box>
  );
};
