/**
 * Python server lifecycle management.
 *
 * Spawns the FastAPI server as a child process on a dynamically
 * allocated port (so multiple CLI sessions can run in parallel)
 * and ensures the child is cleaned up on every exit path.
 *
 * When @anthropic-ai/sandbox-runtime is available, the Python
 * process is wrapped in an OS-level sandbox that restricts
 * filesystem writes to cwd and network access to LLM API hosts.
 */

import { ChildProcess, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { getPythonPath, getPythonSrcDir } from "./setup.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getLLMEnvVars } from "./configManager.js";

const HEALTH_POLL_INTERVAL = 500; // ms
const HEALTH_TIMEOUT = 60_000; // ms

export interface ServerOptions {
  cwd: string;
  configPath?: string;
  port?: number;
  host?: string;
  logLevel?: string;
  /** Path to pre-built GUI static files. Enables --serve-gui on the Python server. */
  guiStaticDir?: string;
}

/**
 * Bind a temporary TCP server to port 0 so the OS assigns a free
 * ephemeral port, then close it and return the port number.
 */
async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, host, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export class ScoutServer {
  private proc: ChildProcess | null = null;
  private _port: number;
  private _host: string;
  private _stderrBuf: string[] = [];
  private _warnings: string[] = [];

  /** Stored references so we can remove them in stop(). */
  private _onExit: (() => void) | null = null;
  private _onSignal: ((sig: NodeJS.Signals) => void) | null = null;

  constructor(private opts: ServerOptions) {
    this._port = opts.port ?? 0;
    this._host = opts.host ?? "127.0.0.1";
  }

  get warnings(): readonly string[] {
    return this._warnings;
  }

  get baseUrl(): string {
    return `http://${this._host}:${this._port}`;
  }

  get port(): number {
    return this._port;
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /**
   * Start the Python server and wait until it's healthy.
   */
  async start(): Promise<void> {
    // Pick a free port if none was explicitly requested
    if (!this._port) {
      this._port = await findFreePort(this._host);
    }

    const pythonPath = getPythonPath();
    const pythonSrc = getPythonSrcDir();
    const absCwd = resolve(this.opts.cwd);

    const llmEnv = getLLMEnvVars();
    const env = {
      ...process.env,
      ...llmEnv,
      PYTHONPATH: pythonSrc,
      PYTHONUNBUFFERED: "1",
    };

    const args = [
      "-m",
      "scout.server",
      "--cwd",
      absCwd,
      "--port",
      String(this._port),
      "--host",
      this._host,
      "--log-level",
      this.opts.logLevel ?? "INFO",
      "--parent-pid",
      String(process.pid),
    ];

    if (this.opts.configPath) {
      args.push("--config", resolve(this.opts.configPath));
    }

    if (this.opts.guiStaticDir) {
      args.push("--serve-gui", resolve(this.opts.guiStaticDir));
    }

    // Attempt sandbox wrapping for OS-level isolation
    let useSandbox = false;
    try {
      if (SandboxManager.isSupportedPlatform()) {
        const scoutConfigDir = `${homedir()}/.config/scout`;
        const scoutHomeDir = `${homedir()}/.scout`;

        const denyRead = [
          // Home directory secrets
          `${homedir()}/.ssh`,
          `${homedir()}/.gnupg`,
          `${homedir()}/.aws`,
          `${homedir()}/.docker/config.json`,
          `${homedir()}/.netrc`,
          `${homedir()}/.npmrc`,
          `${homedir()}/.pypirc`,
          // Env files anywhere in the project (glob — expanded by sandbox on Linux)
          `${absCwd}/.env*`,
          `${absCwd}/**/.env*`,
          // Other credential files in the project
          `${absCwd}/**/*secret*`,
          `${absCwd}/**/*credential*`,
          `${absCwd}/**/.npmrc`,
          `${absCwd}/**/.htpasswd`,
          `${absCwd}/**/id_rsa`,
          `${absCwd}/**/id_ed25519`,
        ];

        await SandboxManager.initialize(
          {
            filesystem: {
              allowWrite: [absCwd, scoutConfigDir, scoutHomeDir, "//tmp"],
              denyRead,
              denyWrite: [],
            },
            network: {
              allowedDomains: [
                "api.groq.com",
                "api.openai.com",
                "api.anthropic.com",
                "127.0.0.1",
                "localhost",
              ],
              deniedDomains: [],
            },
          },
          async () => true,
        );
        useSandbox = true;
      }
    } catch (sandboxErr) {
      const reason =
        sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr);
      this._warnings.push(
        `Sandbox unavailable: ${reason}. ` +
          `User code execution is disabled unless execution.allow_insecure_local_fallback is enabled.`
      );
    }

    if (useSandbox) {
      const rawCmd = [pythonPath, ...args].map((a) => `'${a}'`).join(" ");
      try {
        const sandboxedCmd = await SandboxManager.wrapWithSandbox(rawCmd);
        this.proc = spawn("sh", ["-c", sandboxedCmd], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (wrapErr) {
        const reason =
          wrapErr instanceof Error ? wrapErr.message : String(wrapErr);
        this._warnings.push(
          `Sandbox wrapping failed: ${reason}. User execution may be unavailable.`
        );
        this.proc = spawn(pythonPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      }
    } else {
      this.proc = spawn(pythonPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    }

    this.proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg) return;
      this._stderrBuf.push(msg);
      if (this._stderrBuf.length > 80) this._stderrBuf.shift();
      if (process.env.SCOUT_DEBUG) {
        process.stderr.write(`[server] ${msg}\n`);
      }
    });

    this.proc.on("exit", () => {});

    this.registerCleanupHandlers();

    await this.waitForHealth();

    // Push any startup warnings to the Python server so the GUI can see them
    if (this._warnings.length > 0) {
      fetch(`${this.baseUrl}/warnings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warnings: this._warnings }),
      }).catch(() => {});
    }
  }

  /**
   * Gracefully stop the server and remove cleanup handlers.
   */
  stop(): void {
    this.removeCleanupHandlers();
    this.killChild();
    SandboxManager.reset().catch(() => {});
  }

  // ── Cleanup machinery ──────────────────────────────────────────

  /**
   * Register handlers on the parent Node.js process so the Python
   * child is always killed, even on Ctrl+C or terminal close.
   */
  private registerCleanupHandlers(): void {
    // Synchronous last-resort: 'exit' fires after the event loop
    // has drained — only synchronous calls work here.
    this._onExit = () => this.killChild("SIGKILL");
    process.on("exit", this._onExit);

    // Graceful signal handlers: stop the child then re-raise the
    // signal so the default handler can set the correct exit code.
    this._onSignal = (sig: NodeJS.Signals) => {
      this.killChild();
      this.removeCleanupHandlers();
      process.kill(process.pid, sig);
    };

    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      process.on(sig, this._onSignal);
    }
  }

  private removeCleanupHandlers(): void {
    if (this._onExit) {
      process.removeListener("exit", this._onExit);
      this._onExit = null;
    }
    if (this._onSignal) {
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
        process.removeListener(sig, this._onSignal);
      }
      this._onSignal = null;
    }
  }

  /**
   * Kill the Python child. Tries process-group kill first so any
   * grandchildren (conda interpreter, pandas subprocesses) are
   * also cleaned up.
   */
  private killChild(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.proc || this.proc.exitCode !== null) {
      this.proc = null;
      return;
    }
    const pid = this.proc.pid;
    if (pid) {
      try {
        // Negative PID → kill entire process group
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone
        }
      }
    }
    this.proc = null;
  }

  // ── Health polling ────────────────────────────────────────────

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT;
    const url = `${this.baseUrl}/health`;

    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        const stderrText = this._stderrBuf.join("\n");
        throw new Error(
          `Server process exited with code ${this.proc.exitCode}.\n` +
            (stderrText
              ? `Server output:\n${stderrText}`
              : "No output captured — try SCOUT_DEBUG=1 for details.")
        );
      }

      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const body = (await resp.json()) as {
            status?: string;
            error?: string;
          };
          if (body.status === "ok") {
            return;
          }
          if (body.status === "error" || body.status === "degraded") {
            throw new Error(
              `Agent initialization failed:\n${body.error ?? "unknown error"}`
            );
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Agent init")) {
          throw err;
        }
      }

      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    const stderr = this._stderrBuf.join("\n");
    throw new Error(
      `Server did not become ready within ${HEALTH_TIMEOUT / 1000}s.\n` +
        (stderr
          ? `Server output:\n${stderr}`
          : "No output captured — try SCOUT_DEBUG=1 for details.")
    );
  }
}
