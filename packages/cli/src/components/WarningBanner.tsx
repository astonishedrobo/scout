/**
 * Persistent warning banner pinned above the input area.
 *
 * Single solid red-background block with wrapped text, similar to
 * Alacritty's config error display.  Dismissed via Esc key (handled
 * by the parent).
 */

import React from "react";
import { Box, Text } from "ink";

interface WarningBannerProps {
  warnings: readonly string[];
  width: number;
}

const BG = "#5C1010";

export const WarningBanner: React.FC<WarningBannerProps> = ({
  warnings,
  width,
}) => {
  if (warnings.length === 0) return null;

  const innerWidth = Math.max(10, width - 4);

  return (
    <Box
      flexDirection="column"
      marginLeft={1}
      marginTop={1}
      paddingX={1}
      paddingY={0}
      width={width - 2}
      borderStyle="single"
      borderColor="#FF6B6B"
    >
      {/* Header: title + dismiss hint */}
      <Box justifyContent="space-between" width={innerWidth}>
        <Text color="#FF6B6B" bold> ⚠ Warning</Text>
        <Text color="#878787" dimColor>Esc to dismiss</Text>
      </Box>

      {/* Warning messages — wrap naturally */}
      {warnings.map((msg, i) => (
        <Text key={i} color="#FFAAAA" wrap="wrap">
          {msg}
        </Text>
      ))}
    </Box>
  );
};
