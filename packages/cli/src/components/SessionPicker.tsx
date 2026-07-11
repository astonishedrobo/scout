/**
 * Arrow-key navigable session selector overlay.
 *
 * Rendered when the user types `/resume`.
 * Up/Down to navigate, Enter to select, Esc to cancel.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "scout-core";
import type { SessionMeta } from "scout-core";
import { PickerList } from "./PickerList.js";

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
  if (sessions.length === 0) {
    return (
      <Box paddingLeft={2} marginBottom={1}>
        <Text color={theme.text.secondary} italic>
          No previous sessions found for this project.
        </Text>
      </Box>
    );
  }

  return (
    <PickerList
      title="Resume a session"
      items={sessions.map((session) => ({
        label: truncate(session.title, 45),
        detail: `${relativeTime(session.updatedAt)} · ${session.messageCount} msg${session.messageCount !== 1 ? "s" : ""}`,
      }))}
      onSelect={(index) => onSelect(sessions[index]!)}
      onCancel={onCancel}
    />
  );
};
