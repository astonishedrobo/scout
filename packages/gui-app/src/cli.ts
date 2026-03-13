#!/usr/bin/env node

import { Command } from "commander";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const program = new Command();
const __dirname = dirname(fileURLToPath(import.meta.url));

program
  .name("scout-app")
  .description("Scout — launch Electron desktop app")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to project config YAML")
  .option("-p, --port <port>", "Preferred API port (0 = random)", "0")
  .action((opts: { config?: string; port: string }) => {
    const require = createRequire(import.meta.url);
    const electronBinary = require("electron") as string;
    const mainPath = resolve(__dirname, "main.js");

    if (!existsSync(mainPath)) {
      console.error("Electron main file missing. Build first: npm run build --workspace=packages/gui-app");
      process.exit(1);
    }

    const electronArgs = [mainPath];
    if (process.platform === "linux") {
      electronArgs.push("--no-sandbox");
    }

    const child = spawn(electronBinary, electronArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        SCOUT_APP_CWD: process.cwd(),
        SCOUT_APP_CONFIG: opts.config ?? "",
        SCOUT_APP_PORT: opts.port ?? "0",
      },
    });

    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.parse();
