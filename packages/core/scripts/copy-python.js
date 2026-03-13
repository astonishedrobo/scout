#!/usr/bin/env node
/**
 * Copy the Python source + requirements into packages/core/python/ so that
 * `npm pack` / `npm publish` can bundle them alongside the compiled JS.
 *
 * Layout after copy:
 *   packages/core/python/
 *     src/scout/          (the Python package)
 *     requirements.txt    (pip deps for ~/.scout/env/)
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(__dirname, "..");
const repoRoot = resolve(coreRoot, "..", "..");

const SRC = join(repoRoot, "python");
const DEST = join(coreRoot, "python");

if (!existsSync(join(SRC, "src", "scout"))) {
  console.error("ERROR: Python source not found at", join(SRC, "src", "scout"));
  process.exit(1);
}
if (!existsSync(join(SRC, "requirements.txt"))) {
  console.error("ERROR: requirements.txt not found at", join(SRC, "requirements.txt"));
  process.exit(1);
}

if (existsSync(DEST)) {
  rmSync(DEST, { recursive: true, force: true });
}
mkdirSync(DEST, { recursive: true });

cpSync(join(SRC, "src", "scout"), join(DEST, "src", "scout"), {
  recursive: true,
  filter: (src) => {
    if (src.includes("__pycache__")) return false;
    if (src.endsWith(".pyc")) return false;
    if (src.includes(".egg-info")) return false;
    return true;
  },
});

cpSync(join(SRC, "requirements.txt"), join(DEST, "requirements.txt"));

console.log("✓ Python source copied to packages/core/python/");
