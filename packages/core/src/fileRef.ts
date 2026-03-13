/**
 * Parse @ file references from user input.
 *
 * Detects tokens like `@path/to/file.csv` or `@./relative/file.pdf`
 * in the message and resolves them to absolute paths.
 *
 * Returns:
 * - cleanedMessage: the message with @refs removed
 * - attachments: list of resolved absolute file paths
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Attachment } from "./types.js";

// Matches @followed-by-path-chars. Stops at whitespace, end of line, or
// common punctuation that wouldn't be part of a path.
const AT_REF_RE = /@((?:\.{0,2}\/)?[^\s,;'"]+)/g;

export interface ParseResult {
  cleanedMessage: string;
  attachments: Attachment[];
}

/**
 * Extract @file references from user input.
 *
 * @param message - Raw user input
 * @param cwd - Working directory for relative path resolution
 */
export function parseFileRefs(
  message: string,
  cwd: string = process.cwd()
): ParseResult {
  const attachments: Attachment[] = [];
  let cleaned = message;

  // Find all @ references
  const matches = [...message.matchAll(AT_REF_RE)];

  for (const match of matches) {
    const rawPath = match[1]!;
    const absPath = resolve(cwd, rawPath);

    if (existsSync(absPath)) {
      attachments.push({
        path: absPath,
        name: rawPath.split("/").pop() || rawPath,
      });
      // Remove the @ref from the message
      cleaned = cleaned.replace(match[0], "").trim();
    }
    // If file doesn't exist, leave the @ref as-is (might be @mention syntax)
  }

  return { cleanedMessage: cleaned, attachments };
}
