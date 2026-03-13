#!/usr/bin/env node
/**
 * Scout GUI launcher.
 *
 * Starts the Python server with --serve-gui pointing to the
 * pre-built static files, then opens the browser.
 */

import { Command } from "commander";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const program = new Command();

program
  .name("scout-gui")
  .description("Scout — launch the browser-based GUI")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to project config YAML")
  .option("-p, --port <port>", "Port to run on", "0")
  .action(async (opts: { config?: string; port: string }) => {
    const { ensureSetup, ScoutServer } = await import("scout-core");

    await ensureSetup();

    const cwd = process.cwd();
    const guiDist = resolve(__dirname, "web");

    if (!existsSync(guiDist)) {
      console.error(
        "GUI static files not found. Run `npm run build` in packages/gui first.",
      );
      process.exit(1);
    }

    const port = parseInt(opts.port) || 0;
    const server = new ScoutServer({
      cwd,
      configPath: opts.config,
      port,
      guiStaticDir: guiDist,
    });

    console.log("Starting Scout server...");
    await server.start();
    const url = server.baseUrl;

    console.log(`Scout GUI available at: ${url}`);

    // Open browser
    try {
      const open = (await import("open")).default;
      await open(url);
    } catch {
      console.log(`Open ${url} in your browser`);
    }

    // Keep alive
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      server.stop();
      process.exit(0);
    });
  });

program.parse();
