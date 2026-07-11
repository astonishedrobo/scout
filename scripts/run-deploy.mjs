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
const packages = {
  core: join(root, "packages", "core"),
  cli: join(root, "packages", "cli"),
  scout: join(root, "packages", "scout"),
};
const entry = join(packages.scout, "dist", "index.js");

function ensureBuildDependencies() {
  const compiler = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (existsSync(compiler)) return true;

  process.stderr.write("TypeScript is missing; installing the workspace development dependencies…\n");
  const install = spawnSync("npm", ["install", "--include=dev"], {
    cwd: root,
    stdio: "inherit",
  });
  if (install.status !== 0 || !existsSync(compiler)) {
    process.stderr.write(
      "Unable to find tsc. Run `npm install --include=dev` from the repository root, then retry `npm run deploy`.\n",
    );
    return false;
  }
  return true;
}

function newestMtime(dir) {
  let newest = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    newest = Math.max(newest, item.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

const buildTargets = [
  ["build:core", packages.core],
  ["build:cli", packages.cli],
  ["build:scout", packages.scout],
];

const stale = buildTargets.some(([, pkg]) => {
  const output = join(pkg, "dist", "index.js");
  return !existsSync(output) || newestMtime(join(pkg, "src")) > statSync(output).mtimeMs || statSync(join(pkg, "tsconfig.json")).mtimeMs > statSync(output).mtimeMs;
});

if (stale) {
  if (!ensureBuildDependencies()) process.exit(1);
  for (const [script] of buildTargets) {
    const build = spawnSync("npm", ["run", "-s", script], { cwd: root, encoding: "utf8" });
    if (build.status !== 0) {
      process.stdout.write(build.stdout ?? "");
      process.stderr.write(build.stderr ?? "");
      process.exit(build.status ?? 1);
    }
  }
}

const child = spawn(process.execPath, [entry, "deploy", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
