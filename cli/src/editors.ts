/**
 * Editor detection, selection, and launch utilities.
 *
 * Maintains a registry of known editors, probes for installation
 * via `which`, and handles launching with correct flags for
 * terminal vs GUI editors.
 *
 * Terminal editors need raw mode disabled (Ink keeps stdin in raw mode)
 * so they can interact with the terminal properly.
 */

import { execSync, spawnSync, spawn } from "node:child_process";
import { getConfigValue, setConfigValue } from "./configManager.js";

export interface EditorDef {
  id: string;
  name: string;
  commands: string[];
  type: "terminal" | "gui";
}

export interface EditorInfo extends EditorDef {
  installed: boolean;
  resolvedCommand: string | null;
}

const EDITORS: EditorDef[] = [
  { id: "cursor", name: "Cursor", commands: ["cursor"], type: "gui" },
  { id: "emacs", name: "Emacs", commands: ["emacs"], type: "terminal" },
  { id: "neovim", name: "Neovim", commands: ["nvim"], type: "terminal" },
  { id: "vim", name: "Vim", commands: ["vim"], type: "terminal" },
  { id: "vscode", name: "VS Code", commands: ["code"], type: "gui" },
  { id: "vscodium", name: "VSCodium", commands: ["codium"], type: "gui" },
  { id: "nano", name: "Nano", commands: ["nano"], type: "terminal" },
  { id: "zed", name: "Zed", commands: ["zed"], type: "gui" },
];

function whichCommand(cmd: string): string | null {
  try {
    const result = execSync(
      process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`,
      { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const path = result.trim().split("\n")[0]?.trim();
    return path || null;
  } catch {
    return null;
  }
}

let _cache: EditorInfo[] | null = null;

/** Return all known editors with installation status. Cached after first call. */
export function getAvailableEditors(): EditorInfo[] {
  if (_cache) return _cache;
  _cache = EDITORS.map((def) => {
    let resolvedCommand: string | null = null;
    for (const cmd of def.commands) {
      const path = whichCommand(cmd);
      if (path) {
        resolvedCommand = cmd;
        break;
      }
    }
    return { ...def, installed: resolvedCommand !== null, resolvedCommand };
  });
  return _cache;
}

/** Check if any editor is available (configured, env var, or vi fallback). */
export function hasEditorAvailable(): boolean {
  const prefId = getPreferredEditorId();
  if (prefId) {
    const editors = getAvailableEditors();
    if (editors.some((e) => e.id === prefId && e.installed)) return true;
  }
  if (process.env["VISUAL"] || process.env["EDITOR"]) return true;
  return whichCommand("vi") !== null || whichCommand("nano") !== null;
}

/** Get the currently configured editor id from global config. */
export function getPreferredEditorId(): string | null {
  const val = getConfigValue("general.preferredEditor");
  return typeof val === "string" && val !== "" ? val : null;
}

/** Persist the editor preference to global config. */
export function setPreferredEditorId(id: string | null): void {
  setConfigValue("general.preferredEditor", id ?? "", "global");
}

/** Resolve the preferred editor to a command string, with fallbacks. */
export function resolveEditorCommand(): { command: string; type: "terminal" | "gui" } {
  const prefId = getPreferredEditorId();
  if (prefId) {
    const editors = getAvailableEditors();
    const match = editors.find((e) => e.id === prefId && e.installed);
    if (match?.resolvedCommand) {
      return { command: match.resolvedCommand, type: match.type };
    }
  }

  const envEditor =
    process.env["VISUAL"] ?? process.env["EDITOR"];
  if (envEditor) {
    const lower = envEditor.toLowerCase();
    const isGui = ["code", "cursor", "subl", "zed", "codium"].some((g) =>
      lower.includes(g),
    );
    return { command: envEditor, type: isGui ? "gui" : "terminal" };
  }

  return { command: process.platform === "win32" ? "notepad" : "vi", type: "terminal" };
}

/**
 * Launch editor on the given file paths. Blocks until the editor closes.
 *
 * Terminal editors need raw mode toggled off so they can properly
 * interact with the terminal (Ink keeps stdin in raw mode). We
 * restore raw mode after the editor exits.
 */
export async function launchEditor(filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return;

  const { command, type } = resolveEditorCommand();
  const [executable = "", ...baseArgs] = command.split(" ");

  const args = [...baseArgs];

  if (type === "gui") {
    args.push("--wait");
  }

  if (
    type === "terminal" &&
    (executable.includes("vi") || executable.includes("vim") || executable.includes("nvim"))
  ) {
    args.push("-i", "NONE");
  }

  args.push(...filePaths);

  // Toggle raw mode off for terminal editors (Ink keeps stdin raw)
  const wasRaw = process.stdin.isRaw ?? false;
  if (type === "terminal" && wasRaw) {
    process.stdin.setRawMode(false);
  }

  try {
    if (type === "terminal") {
      const result = spawnSync(executable, args, {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      if (result.error) throw result.error;
      if (typeof result.status === "number" && result.status !== 0) {
        throw new Error(`Editor exited with status ${result.status}`);
      }
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (typeof code === "number" && code !== 0) {
            reject(new Error(`Editor exited with status ${code}`));
          } else {
            resolve();
          }
        });
      });
    }
  } finally {
    if (wasRaw) {
      process.stdin.setRawMode(true);
    }
  }
}
