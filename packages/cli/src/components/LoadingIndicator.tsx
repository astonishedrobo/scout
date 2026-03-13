/**
 * Inline loading indicator — spinner + label + elapsed timer.
 *
 * Mirrors Gemini CLI's `LoadingIndicator` (inline variant):
 *   ⠋ Thinking…  (12s)
 *   ⠋ Running run_code…  (4s)
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme } from "scout-core";

interface LoadingIndicatorProps {
  /** Whether the indicator should be visible. */
  active: boolean;
  /** Optional current tool name. */
  currentTool?: string;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  active,
  currentTool,
}) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - t0) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [active]);

  if (!active) return null;

  const label = currentTool ? `Running ${currentTool}` : "Thinking";

  return (
    <Box>
      <Box marginRight={1}>
        <Text color={theme.ui.spinner}>
          <Spinner type="dots" />
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.text.primary} italic>
          {label}…
        </Text>
      </Box>
      {elapsed > 0 && (
        <>
          <Box flexShrink={0} width={1} />
          <Text color={theme.text.secondary}>
            ({formatElapsed(elapsed)})
          </Text>
        </>
      )}
    </Box>
  );
};
