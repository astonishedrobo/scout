/**
 * Application header — Gemini-style, no border.
 *
 * Layout:
 *   ✦ Scout  v0.1.0  ● model-name
 *
 * A single clean text line followed by nothing; the ThinkingBar /
 * LoadingIndicator lives in App.tsx next to the Composer area.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

interface StatusBarProps {
  model: string;
  connected: boolean;
  /** Optional version string to display. */
  version?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  model,
  connected,
  version = "0.1.0",
}) => {
  return (
    <Box marginTop={1} marginBottom={1} paddingLeft={2}>
      <Text color={theme.text.accent} bold>
        ✦ Scout
      </Text>
      <Text color={theme.text.secondary}> v{version}</Text>
      <Text color={theme.text.secondary}>  </Text>
      <Text color={connected ? theme.status.success : theme.status.error}>
        {connected ? "●" : "○"}
      </Text>
      <Text color={theme.text.secondary}> {model}</Text>
    </Box>
  );
};
