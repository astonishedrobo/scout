/**
 * First-run bootstrap: ensure Python environment + global config exist.
 *
 * 1. Check for Python 3.10+
 * 2. Create venv at ~/.scout/env/ (if not exists)
 * 3. Install Python dependencies from bundled requirements.txt
 * 4. Check for global config, prompt wizard if missing
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import {
  globalConfigExists,
  writeGlobalConfig,
} from "./configManager.js";

const SCOUT_HOME = join(homedir(), ".scout");
const VENV_DIR = join(SCOUT_HOME, "env");
const VENV_PYTHON = join(VENV_DIR, "bin", "python");
const VENV_PIP = join(VENV_DIR, "bin", "pip");

/** Locate the bundled Python source relative to the CLI dist/ dir.
 *
 * Production (npm installed):
 *   node_modules/scout-cli/dist/setup.js  →  ../python/
 *
 * Development (monorepo):
 *   cli/dist/setup.js  →  ../../python/
 */
function bundledPythonDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Production: python/ is a sibling of dist/ inside the npm package
  const prodPath = resolve(thisDir, "..", "python");
  if (existsSync(join(prodPath, "requirements.txt"))) return prodPath;

  // Development: python/ is at the monorepo root, sibling of cli/
  const devPath = resolve(thisDir, "..", "..", "python");
  if (existsSync(join(devPath, "requirements.txt"))) return devPath;

  throw new Error(
    "Could not locate bundled Python source. " +
      `Checked:\n  ${prodPath}\n  ${devPath}`
  );
}

function bundledRequirements(): string {
  return join(bundledPythonDir(), "requirements.txt");
}

/** Get the venv Python path (or the system Python if no venv). */
export function getPythonPath(): string {
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON;
  // Fallback: try system python
  try {
    const p = execSync("which python3", { encoding: "utf-8" }).trim();
    if (p) return p;
  } catch {
    /* ignore */
  }
  try {
    const p = execSync("which python", { encoding: "utf-8" }).trim();
    if (p) return p;
  } catch {
    /* ignore */
  }
  throw new Error("Python 3.10+ is required but not found on PATH.");
}

/** Get the bundled Python source directory. */
export function getPythonSrcDir(): string {
  return join(bundledPythonDir(), "src");
}

/** Check Python version >= 3.10. */
function checkPythonVersion(pythonPath: string): boolean {
  try {
    const version = execSync(`${pythonPath} --version`, {
      encoding: "utf-8",
    }).trim();
    const match = version.match(/Python (\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match;
    return parseInt(major!) >= 3 && parseInt(minor!) >= 10;
  } catch {
    return false;
  }
}

/** Create the venv if it doesn't exist. */
function ensureVenv(): void {
  if (existsSync(VENV_PYTHON)) return;

  console.log(chalk.blue("Setting up Python environment..."));

  // Find a suitable Python
  let systemPython = "";
  for (const cmd of ["python3", "python"]) {
    try {
      const p = execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
      if (p && checkPythonVersion(p)) {
        systemPython = p;
        break;
      }
    } catch {
      /* try next */
    }
  }

  if (!systemPython) {
    console.error(
      chalk.red(
        "Error: Python 3.10+ is required. Please install Python and try again."
      )
    );
    process.exit(1);
  }

  // Create venv
  mkdirSync(SCOUT_HOME, { recursive: true });
  console.log(chalk.gray(`  Creating venv at ${VENV_DIR}...`));
  execSync(`${systemPython} -m venv ${VENV_DIR}`, { stdio: "pipe" });
  console.log(chalk.green("  ✓ Virtual environment created"));
}

/** Install Python dependencies. */
function installDeps(): void {
  const reqFile = bundledRequirements();
  if (!existsSync(reqFile)) {
    console.warn(
      chalk.yellow("  Warning: requirements.txt not found — skipping dep install")
    );
    return;
  }

  // Check if deps are current by comparing requirements.txt mtime
  // with a marker file
  const markerFile = join(VENV_DIR, ".deps_installed");
  if (existsSync(markerFile)) {
    const { mtimeMs: reqMtime } = statSync(reqFile);
    const { mtimeMs: markerMtime } = statSync(markerFile);
    if (markerMtime >= reqMtime) {
      return; // deps are current
    }
  }

  console.log(chalk.gray("  Installing Python dependencies..."));
  execSync(`${VENV_PIP} install -q -r ${reqFile}`, {
    stdio: "pipe",
    timeout: 300_000, // 5 min
  });

  // Write marker
  writeFileSync(markerFile, new Date().toISOString());
  console.log(chalk.green("  ✓ Dependencies installed"));
}

/** Run the first-run setup wizard (global config). */
function runWizard(): void {
  console.log(chalk.bold("\n  Welcome to Scout! Let's get you set up.\n"));

  // Non-interactive defaults (user can change later with /config)
  const defaultModel = "groq/llama-3.1-8b-instant";
  console.log(chalk.gray(`  Default model: ${defaultModel}`));
  console.log(
    chalk.gray("  Change anytime with: /model <name> or /config set agent.model <name>\n")
  );

  writeGlobalConfig({
    agent: {
      model: defaultModel,
      temperature: 0.2,
      max_iterations: 15,
      code_timeout: 30,
      conda_env: "agents",
    },
    pdf: {
      parser: "pdfplumber",
    },
  });

  console.log(
    chalk.green(`  ✓ Config saved to ~/.config/scout/config.yaml\n`)
  );
  console.log(chalk.gray("  To configure a project:"));
  console.log(chalk.gray("    cd your-project && scout init\n"));
}

/**
 * Ensure everything is ready to run Scout.
 * Call this before starting the server/UI.
 */
export async function ensureSetup(): Promise<void> {
  ensureVenv();
  installDeps();

  if (!globalConfigExists()) {
    runWizard();
  }
}
