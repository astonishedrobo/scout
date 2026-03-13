/**
 * Heuristic-based broad directory detection.
 *
 * Returns a warning string when the working directory looks too
 * broad (home, root, or contains too many top-level entries).
 * All checks use runtime properties -- no hardcoded paths.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const MAX_TOP_LEVEL_DIRS = 50;

export function checkBroadDirectory(dir: string): string | null {
  const abs = resolve(dir);
  const home = homedir();

  if (abs === "/") {
    return (
      "You are running Scout in the root directory. " +
      "Your entire filesystem will be used for context. " +
      "It is strongly recommended to run in a project directory."
    );
  }

  if (abs === home) {
    return (
      "You are running Scout in your home directory. " +
      "It is recommended to run in a project-specific directory."
    );
  }

  if (home.startsWith(abs + "/")) {
    return (
      "You are running Scout in a parent of your home directory. " +
      "Consider running in a more specific project folder."
    );
  }

  try {
    const entries = readdirSync(abs, { withFileTypes: true });
    const dirCount = entries.filter((e) => e.isDirectory()).length;
    if (dirCount > MAX_TOP_LEVEL_DIRS) {
      return (
        `This directory contains ${dirCount} subdirectories. ` +
        "Consider running in a more specific project folder."
      );
    }
  } catch {
    // permission error or similar -- ignore
  }

  return null;
}
