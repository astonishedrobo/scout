/**
 * Arrow-key navigable session selector overlay.
 *
 * Rendered when the user types `/resume`.
 * Up/Down to navigate, Enter to select, Esc to cancel.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import type { SessionMeta } from "../sessionStore.js";

const MAX_VISIBLE = 8;

interface SessionPickerProps {
  sessions: SessionMeta[];
  onSelect: (session: SessionMeta) => void;
  onCancel: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export const SessionPicker: React.FC<SessionPickerProps> = ({
  sessions,
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
      setActiveIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      const selected = sessions[activeIndex];
      if (selected) onSelect(selected);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  if (sessions.length === 0) {
    return (
      <Box paddingLeft={2} marginBottom={1}>
        <Text color={theme.text.secondary} italic>
          No previous sessions found for this project.
        </Text>
      </Box>
    );
  }

  let startIdx = 0;
  if (activeIndex >= MAX_VISIBLE) {
    startIdx = activeIndex - MAX_VISIBLE + 1;
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, sessions.length);
  const visible = sessions.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text color={theme.text.secondary} italic>
        Resume a session (↑↓ navigate, Enter select, Esc cancel):
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {startIdx > 0 && (
          <Text color={theme.text.secondary}>  ▲</Text>
        )}

        {visible.map((s, i) => {
          const realIdx = startIdx + i;
          const isActive = realIdx === activeIndex;
          const title = truncate(s.title, 45);
          const time = relativeTime(s.updatedAt);
          const msgs = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`;

          return (
            <Box key={s.sessionId}>
              <Text color={isActive ? theme.text.accent : theme.text.secondary}>
                {isActive ? "❯ " : "  "}
              </Text>
              <Text
                color={isActive ? theme.text.primary : theme.text.secondary}
                bold={isActive}
              >
                {title}
              </Text>
              <Text color={theme.text.secondary} dimColor>
                {"  "}
                {time} · {msgs}
              </Text>
            </Box>
          );
        })}

        {endIdx < sessions.length && (
          <Text color={theme.text.secondary}>  ▼</Text>
        )}

        {sessions.length > MAX_VISIBLE && (
          <Text color={theme.text.secondary} dimColor>
            {"  "}({activeIndex + 1}/{sessions.length})
          </Text>
        )}
      </Box>
    </Box>
  );
};
