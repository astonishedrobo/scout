/**
 * File-change approval prompt overlay.
 *
 * Shows a colored unified diff of actual file changes detected after
 * tool execution.  Four options: Yes (allow once), Yes (allow always),
 * Modify with external editor, No (reject + revert).
 *
 * If "Suggest changes" is selected via number key, transitions to a
 * text input for feedback.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { theme } from "../theme.js";
import type { FileDiffEntry } from "../types.js";

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  diffs: FileDiffEntry[];
}

export type ApprovalAction = "yes" | "always" | "edit" | "no" | "suggest";

interface ApprovalPromptProps {
  request: ApprovalRequest;
  onRespond: (action: ApprovalAction, feedback?: string) => void;
}

const OPTIONS: { key: ApprovalAction; label: string; num: string }[] = [
  { key: "yes", label: "Yes, allow once", num: "1" },
  { key: "always", label: "Yes, allow always", num: "2" },
  { key: "edit", label: "Modify with external editor", num: "3" },
  { key: "no", label: "No, reject changes (esc)", num: "4" },
];

const MAX_DIFF_LINES = 12;

function DiffView({ entry }: { entry: FileDiffEntry }) {
  const lines = entry.diff.split("\n");

  const bodyLines = lines.filter(
    (l) =>
      !l.startsWith("diff --git") &&
      !l.startsWith("index ") &&
      !l.startsWith("---") &&
      !l.startsWith("+++") &&
      !l.startsWith("new file") &&
      !l.startsWith("deleted file"),
  );

  const visible = bodyLines.slice(0, MAX_DIFF_LINES);
  const hidden = bodyLines.length - visible.length;

  const statusColor: string =
    entry.status === "added"
      ? theme.status.success
      : entry.status === "deleted"
        ? theme.status.error
        : theme.status.warning;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={statusColor} bold>
          {"? "}
          {entry.status === "added"
            ? "New"
            : entry.status === "deleted"
              ? "Delete"
              : "Edit"}{" "}
        </Text>
        <Text color={theme.text.link} bold>
          {entry.path}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {visible.map((line, i) => {
          let color: string = theme.text.secondary;
          if (line.startsWith("+")) color = theme.status.success;
          else if (line.startsWith("-")) color = theme.status.error;
          else if (line.startsWith("@@")) color = theme.text.link;

          return (
            <Text key={i} color={color} wrap="truncate">
              {line}
            </Text>
          );
        })}
        {hidden > 0 && (
          <Text color={theme.text.secondary} dimColor>
            {"  "}... {hidden} more lines hidden
          </Text>
        )}
      </Box>
    </Box>
  );
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({
  request,
  onRespond,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");

  useInput((input, key) => {
    if (feedbackMode) {
      if (key.escape) {
        setFeedbackMode(false);
        setFeedback("");
      }
      return;
    }

    if (key.upArrow) {
      setActiveIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setActiveIndex((prev) => Math.min(OPTIONS.length - 1, prev + 1));
    } else if (key.return) {
      onRespond(OPTIONS[activeIndex]!.key);
    } else if (key.escape) {
      onRespond("no");
    } else if (input === "s" || input === "S") {
      setFeedbackMode(true);
    } else {
      const numIdx = OPTIONS.findIndex((o) => o.num === input);
      if (numIdx >= 0) {
        onRespond(OPTIONS[numIdx]!.key);
      }
    }
  });

  const handleFeedbackSubmit = (value: string) => {
    if (value.trim()) {
      onRespond("suggest", value.trim());
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      {/* Diff display */}
      {request.diffs.map((entry, i) => (
        <DiffView key={i} entry={entry} />
      ))}

      {/* Options or feedback input */}
      {!feedbackMode ? (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            Apply this change?
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {OPTIONS.map((opt, i) => {
              const isActive = i === activeIndex;
              return (
                <Box key={opt.key}>
                  <Text
                    color={isActive ? theme.text.accent : theme.text.secondary}
                  >
                    {isActive ? "● " : "  "}
                  </Text>
                  <Text
                    color={isActive ? theme.text.primary : theme.text.secondary}
                    bold={isActive}
                  >
                    {opt.num}. {opt.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Text color={theme.text.secondary} dimColor>
            {"  "}(↑↓ or 1-4 to pick, Enter to confirm, S to suggest changes)
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={theme.text.link}>
            Suggest changes (Esc to go back):
          </Text>
          <Box>
            <Text color={theme.text.accent}>{"> "}</Text>
            <TextInput
              value={feedback}
              onChange={setFeedback}
              onSubmit={handleFeedbackSubmit}
              placeholder="Type your suggestion..."
            />
          </Box>
        </Box>
      )}
    </Box>
  );
};
