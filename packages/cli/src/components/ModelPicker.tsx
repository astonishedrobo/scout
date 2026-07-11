/**
 * Arrow-key navigable model selector overlay.
 *
 * Rendered when the user types `/model` without arguments.
 * Up/Down to navigate, Enter to select, Escape to cancel.
 */

import React from "react";
import { PickerList } from "./PickerList.js";

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
  if (models.length === 0) return null;
  return (
    <PickerList
      title="Select a model"
      items={models.map((model) => ({
        label: model,
        badge: model === currentModel ? "current" : undefined,
      }))}
      initialIndex={Math.max(0, models.indexOf(currentModel))}
      onSelect={(index) => onSelect(models[index]!)}
      onCancel={onCancel}
    />
  );
};
