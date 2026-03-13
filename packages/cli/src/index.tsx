#!/usr/bin/env node
/**
 * Scout CLI entry point.
 *
 * Usage:
 *   scout              -- Start interactive session in current directory
 *   scout --config p   -- Use explicit config path (legacy)
 */

import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "./App.js";
import { ensureSetup } from "scout-core";

const program = new Command();

program
  .name("scout")
  .description("Scout — AI-powered data research agent")
  .version("0.1.0");

program
  .option("-c, --config <path>", "Path to project config YAML (optional)")
  .action(async (opts: { config?: string }) => {
    const cwd = process.cwd();
    let configPath: string | undefined = opts.config;

    if (configPath && !existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }

    if (configPath) {
      configPath = resolve(configPath);
    }

    await ensureSetup();

    const { waitUntilExit } = render(
      <App cwd={cwd} configPath={configPath} />,
    );

    await waitUntilExit();
  });

program.parse();
