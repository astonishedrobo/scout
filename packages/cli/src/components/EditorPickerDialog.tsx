/**
 * Editor preference picker dialog.
 *
 * Shows a list of known editors with installation status,
 * allows the user to select one, and persists the choice
 * to the global Scout config.
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "scout-core";
import {
  getAvailableEditors,
  getPreferredEditorId,
  setPreferredEditorId,
  type EditorInfo,
} from "../editors.js";

interface EditorPickerDialogProps {
  /** Called when the dialog closes. `selectedId` is the editor id chosen, or null if cancelled. */
  onClose: (selectedId: string | null) => void;
}

interface ListItem {
  id: string;
  label: string;
  disabled: boolean;
}

export const EditorPickerDialog: React.FC<EditorPickerDialogProps> = ({
  onClose,
}) => {
  const editors = useMemo(() => getAvailableEditors(), []);
  const currentId = useMemo(() => getPreferredEditorId(), []);

  const items: ListItem[] = useMemo(() => {
    const list: ListItem[] = [
      { id: "none", label: "None", disabled: false },
    ];
    for (const e of editors) {
      const suffix = e.installed ? "" : " (Not installed)";
      list.push({ id: e.id, label: `${e.name}${suffix}`, disabled: !e.installed });
    }
    return list;
  }, [editors]);

  const initialIdx = items.findIndex((i) => i.id === (currentId || "none"));
  const [activeIdx, setActiveIdx] = useState(Math.max(0, initialIdx));

  const currentEditorName = useMemo(() => {
    if (!currentId) return "None";
    const ed = editors.find((e) => e.id === currentId);
    return ed?.installed ? ed.name : "None";
  }, [currentId, editors]);

  useInput((input, key) => {
    if (key.escape) {
      onClose(null);
      return;
    }

    if (key.upArrow) {
      setActiveIdx((prev) => {
        let next = prev - 1;
        while (next >= 0 && items[next]!.disabled) next--;
        return next >= 0 ? next : prev;
      });
    } else if (key.downArrow) {
      setActiveIdx((prev) => {
        let next = prev + 1;
        while (next < items.length && items[next]!.disabled) next++;
        return next < items.length ? next : prev;
      });
    } else if (key.return) {
      const selected = items[activeIdx];
      if (selected && !selected.disabled) {
        const newId = selected.id === "none" ? null : selected.id;
        setPreferredEditorId(newId);
        onClose(newId);
      }
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="row"
      paddingX={1}
      paddingY={1}
    >
      {/* Left panel: editor list */}
      <Box flexDirection="column" width="50%">
        <Text bold>{">"} Select Editor</Text>
        <Box flexDirection="column" marginTop={1}>
          {items.map((item, i) => {
            const isActive = i === activeIdx;
            const color: string = item.disabled
              ? theme.text.secondary
              : isActive
                ? theme.text.primary
                : theme.text.secondary;
            return (
              <Box key={item.id}>
                <Text color={isActive && !item.disabled ? theme.status.success : theme.text.secondary}>
                  {isActive ? "● " : "  "}
                </Text>
                <Text color={color} bold={isActive && !item.disabled} dimColor={item.disabled}>
                  {item.label}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            (Use Enter to select, Esc to close)
          </Text>
        </Box>
      </Box>

      {/* Right panel: info */}
      <Box flexDirection="column" width="50%" paddingLeft={2}>
        <Text bold color={theme.text.primary}>
          Editor Preference
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.secondary}>
            These editors are currently supported. Please note that some
            editors cannot be used in sandbox mode.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            Your preferred editor is:{" "}
            <Text
              color={currentEditorName === "None" ? theme.status.error : theme.text.link}
              bold
            >
              {currentEditorName}
            </Text>
            .
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
