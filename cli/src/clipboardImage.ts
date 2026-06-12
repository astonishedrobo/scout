import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[]): Promise<Uint8Array | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "buffer", maxBuffer: 12 * 1024 * 1024 });
    return stdout.length ? new Uint8Array(stdout) : null;
  } catch {
    return null;
  }
}

export async function readClipboardImage(): Promise<{ bytes: Uint8Array; type: string; name: string } | null> {
  if (process.platform === "darwin") {
    const bytes = await run("osascript", ["-e", "set pngData to the clipboard as «class PNGf»", "-e", "return pngData"]);
    return bytes ? { bytes, type: "image/png", name: "pasted-image.png" } : null;
  }
  if (process.platform === "win32") {
    const script = "$i=Get-Clipboard -Format Image;if($i){$m=New-Object IO.MemoryStream;$i.Save($m,[Drawing.Imaging.ImageFormat]::Png);[Console]::OpenStandardOutput().Write($m.ToArray(),0,$m.Length)}";
    const bytes = await run("powershell", ["-NoProfile", "-Command", script]);
    return bytes ? { bytes, type: "image/png", name: "pasted-image.png" } : null;
  }
  for (const [command, args] of [
    ["wl-paste", ["--no-newline", "--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ] as const) {
    const bytes = await run(command, [...args]);
    if (bytes) return { bytes, type: "image/png", name: "pasted-image.png" };
  }
  return null;
}
