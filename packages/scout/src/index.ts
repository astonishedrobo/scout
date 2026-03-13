#!/usr/bin/env node
/**
 * Scout unified entry point.
 *
 *   scout          -- Start interactive CLI session
 *   scout --gui    -- Launch browser-based GUI
 *   scout --app    -- Launch Electron desktop app
 *   scout -c <p>   -- Use explicit config path
 */

import { Command } from "commander";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const program = new Command();

program
  .name("scout")
  .description("Scout — AI-powered data research agent")
  .version("0.1.0")
  .option("--app", "Launch Electron desktop app")
  .option("--gui", "Launch browser-based GUI instead of terminal CLI")
  .option("--multi-user", "Enable multi-user authentication mode")
  .option("-p, --port <number>", "Port to listen on (for GUI mode)", (v) => parseInt(v, 10))
  .option("-c, --config <path>", "Path to project config YAML (optional)")
  .action(async (opts: { app?: boolean; gui?: boolean; multiUser?: boolean; port?: number; config?: string }) => {
    const { ensureSetup } = await import("scout-core");

    const cwd = process.cwd();
    let configPath: string | undefined = opts.config;

    if (configPath && !existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    if (configPath) configPath = resolve(configPath);

    await ensureSetup();

    if (opts.app) {
      const require = createRequire(import.meta.url);
      const appCliPath = require.resolve("scout-gui-app/dist/cli.js");
      const args = [appCliPath];
      if (configPath) args.push("--config", configPath);
      const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    if (opts.gui) {
      // Launch GUI mode
      const { ScoutServer } = await import("scout-core");

      // Find pre-built GUI static files from scout-gui package
      let guiDist: string | undefined;
      try {
        const guiPkg = await import("scout-gui/package.json", {
          with: { type: "json" },
        });
        const guiRoot = dirname(
          (await import("node:module")).createRequire(import.meta.url).resolve(
            "scout-gui/package.json",
          ),
        );
        guiDist = join(guiRoot, "dist", "web");
      } catch {
        // Fallback: check relative to this file (monorepo dev)
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const devDist = resolve(__dirname, "..", "..", "gui", "dist", "web");
        if (existsSync(devDist)) guiDist = devDist;
      }

      if (!guiDist || !existsSync(guiDist)) {
        console.error(
          "GUI static files not found. Build the GUI first: npm run build:gui",
        );
        process.exit(1);
      }

      const server = new ScoutServer({
        cwd,
        configPath,
        guiStaticDir: guiDist,
        multiUser: opts.multiUser,
        port: opts.port,
      });

      console.log("Starting Scout server...");
      await server.start();
      const url = server.baseUrl;
      console.log(`Scout GUI available at: ${url}`);

      try {
        const open = (await import("open")).default;
        await open(url);
      } catch {
        console.log(`Open ${url} in your browser`);
      }

      // Keep process alive
      process.on("SIGINT", () => {
        server.stop();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        server.stop();
        process.exit(0);
      });
    } else {
      // Launch CLI mode (Ink TUI)
      const { render } = await import("ink");
      const React = await import("react");
      const { App } = await import("scout-cli/App");

      const { waitUntilExit } = render(
        React.createElement(App, { cwd, configPath }),
      );
      await waitUntilExit();
    }
  });

program.parse();
