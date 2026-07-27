import { useSyncExternalStore } from "react";
import { readLocalSetting, subscribeLocalSettings } from "./useLocalSetting";

export type Density = "comfortable" | "compact";

const SETTING_KEY = "appearance.density";

function current(): Density {
  return readLocalSetting<Density>(SETTING_KEY, "comfortable");
}

/**
 * Density is expressed as spacing custom properties in globals.css, switched by
 * `:root[data-density="compact"]`. Stamped at module load, before React renders,
 * so nothing paints at one density and reflows to the other.
 */
function applyDensity() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (current() === "compact") root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
}

applyDensity();
subscribeLocalSettings(applyDensity);

export function useDensity(): Density {
  return useSyncExternalStore(subscribeLocalSettings, current, () => "comfortable");
}
