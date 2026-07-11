/**
 * Quiet launcher for `npm run deploy*`.
 *
 * Rebuilds packages/scout only when its sources are newer than the
 * build, keeps the build silent unless it fails, then hands the
 * terminal straight to the deploy TUI.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", "scout");
const entry = join(pkg, "dist", "index.js");

function newestMtime(dir) {
  let newest = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    newest = Math.max(newest, item.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

const stale =
  !existsSync(entry) ||
  Math.max(newestMtime(join(pkg, "src")), statSync(join(pkg, "tsconfig.json")).mtimeMs) > statSync(entry).mtimeMs;

if (stale) {
  const build = spawnSync("npm", ["run", "-s", "build:scout"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    process.stdout.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    process.exit(build.status ?? 1);
  }
}

const child = spawn(process.execPath, [entry, "deploy", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
