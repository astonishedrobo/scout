/**
 * Detect Python environments available for the agent's code session.
 *
 * Checks for local .venv / venv directories in cwd, then queries
 * conda for named environments.  Returns a typed list suitable for
 * the EnvPicker component.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EnvOption {
  label: string;
  value: string;
  type: "venv" | "conda" | "system";
}

export function detectEnvs(cwd: string): EnvOption[] {
  const envs: EnvOption[] = [];

  // Local venvs
  for (const name of [".venv", "venv"]) {
    const pyBin = join(cwd, name, "bin", "python");
    if (existsSync(pyBin)) {
      envs.push({
        label: `${name} (local venv)`,
        value: resolve(pyBin),
        type: "venv",
      });
    }
  }

  // Conda environments
  try {
    const out = execSync("conda info --envs", {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      // Lines look like:  agents    /home/user/.miniconda3/envs/agents
      // or:               base   *  /home/user/.miniconda3
      const name = parts[0];
      const prefix = parts[parts.length - 1];
      if (!name || !prefix || prefix.startsWith("#")) continue;
      const pyBin = join(prefix, "bin", "python");
      if (existsSync(pyBin)) {
        const tag = parts.includes("*") ? " (active)" : "";
        envs.push({
          label: `${name}${tag} (conda)`,
          value: name,
          type: "conda",
        });
      }
    }
  } catch {
    // conda not installed or not on PATH
  }

  // System Python fallback
  envs.push({
    label: "System Python",
    value: "system",
    type: "system",
  });

  return envs;
}
