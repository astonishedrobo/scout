import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ScoutServer,
  ensureSetup,
  detectEnvs,
  setConfigValue,
  getMergedConfig,
  type EnvOption,
} from "scout-core";

let win: BrowserWindow | null = null;
let scoutServer: ScoutServer | null = null;
const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveGuiStaticDir(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("scout-gui/package.json");
    const guiRoot = dirname(pkgPath);
    const dist = join(guiRoot, "dist", "web");
    if (existsSync(dist)) return dist;
  } catch {
    // fall through to monorepo dev path
  }
  const devDist = resolve(__dirname, "..", "..", "gui", "dist", "web");
  if (existsSync(devDist)) return devDist;
  throw new Error("Could not find scout-gui dist/web. Build gui first.");
}

function registerIpc(cwd: string) {
  ipcMain.handle("scout:list-python-envs", async (): Promise<EnvOption[]> => {
    return detectEnvs(cwd);
  });

  ipcMain.handle(
    "scout:select-python-env",
    async (
      _event,
      env: { type: "venv" | "conda" | "system"; value: string },
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        if (env.type === "venv") {
          setConfigValue("agent.python_path", env.value, "project", cwd);
          return { ok: true, message: "Using explicit python_path from venv." };
        }
        if (env.type === "conda") {
          setConfigValue("agent.conda_env", env.value, "project", cwd);
          setConfigValue("agent.python_path", null, "project", cwd);
          return { ok: true, message: "Using selected conda environment." };
        }
        // system
        setConfigValue("agent.python_path", null, "project", cwd);
        return { ok: true, message: "Using system/default python resolution." };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: msg };
      }
    },
  );

  ipcMain.handle("scout:get-selected-python-env", async (): Promise<{
    condaEnv: string | null;
    pythonPath: string | null;
  }> => {
    const cfg = getMergedConfig(cwd);
    return {
      condaEnv: cfg.agent?.conda_env ?? null,
      pythonPath: cfg.agent?.python_path ?? null,
    };
  });
}

async function createWindow() {
  const cwd = process.env.SCOUT_APP_CWD || process.cwd();
  const configPath = process.env.SCOUT_APP_CONFIG || undefined;
  const port = Number.parseInt(process.env.SCOUT_APP_PORT || "0", 10) || 0;

  await ensureSetup();

  const guiStaticDir = resolveGuiStaticDir();
  scoutServer = new ScoutServer({ cwd, configPath, port, guiStaticDir });
  await scoutServer.start();

  registerIpc(cwd);

  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#262624",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadURL(scoutServer.baseUrl);
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error("Failed to start Scout app:", err);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => {
        console.error("Failed to re-create Scout window:", err);
      });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (scoutServer) {
    scoutServer.stop();
    scoutServer = null;
  }
});
