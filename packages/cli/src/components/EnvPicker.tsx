/**
 * Arrow-key navigable Python environment selector overlay.
 *
 * Shown during /init to let the user pick a conda env, local venv,
 * or system Python for the agent's code execution session.
 * Up/Down to navigate, Enter to select, Escape to skip.
 */

import React from "react";
import type { EnvOption } from "scout-core";
import { PickerList } from "./PickerList.js";

interface EnvPickerProps {
  envs: EnvOption[];
  onSelect: (env: EnvOption) => void;
  onCancel: () => void;
}

export const EnvPicker: React.FC<EnvPickerProps> = ({ envs, onSelect, onCancel }) => {
  if (envs.length === 0) return null;
  return (
    <PickerList
      title="Python environment for code execution"
      items={envs.map((env) => ({
        label: env.label,
        detail: env.type === "venv" ? env.value : undefined,
      }))}
      escLabel="skip"
      onSelect={(index) => onSelect(envs[index]!)}
      onCancel={onCancel}
    />
  );
};
