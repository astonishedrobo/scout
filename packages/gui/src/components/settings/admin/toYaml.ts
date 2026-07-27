/**
 * Serialise a plain config object to YAML, for display only.
 *
 * The admin panel used to print the effective config as JSON, for a file the
 * banner directly above it tells you to edit as `config.yaml`. That mismatch is
 * the whole problem: an admin reads a value here, opens the file, and the shapes
 * do not correspond — and copy-paste produces something the loader rejects.
 *
 * This is a display serialiser, not a YAML implementation. No anchors, no tags,
 * no multi-document output, no flow style. It handles what a config payload
 * actually contains: nested maps, arrays, strings, numbers, booleans and null.
 * If a value ever needs round-tripping rather than reading, pull in a real YAML
 * library instead of extending this.
 */

/**
 * Plain, unquoted YAML scalars. Anything outside this — leading/trailing space,
 * a leading indicator character, a value that would otherwise parse as a
 * number/bool/null, or a `: ` / ` #` sequence — gets quoted, because emitting it
 * bare would change its meaning.
 */
const SAFE_PLAIN = /^[A-Za-z_/.][\w\-./@ ]*$/;
const LOOKS_SCALAR = /^(?:true|false|yes|no|on|off|null|~|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/i;

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `"${value}"`;

  const text = String(value);
  if (text === "") return '""';
  if (text.includes("\n")) {
    // Block scalar. `|-` keeps the line breaks and drops the trailing newline,
    // which is what a multi-line config value (a prompt, a key) wants.
    return "|-";
  }
  const needsQuote =
    !SAFE_PLAIN.test(text) ||
    LOOKS_SCALAR.test(text) ||
    text.includes(": ") ||
    text.includes(" #") ||
    text !== text.trim();
  return needsQuote ? JSON.stringify(text) : text;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emit(value: unknown, indent: number, lines: string[]): void {
  const pad = "  ".repeat(indent);

  if (isMap(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      // A nested empty map is appended to its own key line by the caller; only
      // a top-level empty document reaches here with nothing to append to.
      if (lines.length === 0) lines.push("{}");
      return;
    }
    for (const [key, child] of entries) {
      const label = SAFE_PLAIN.test(key) && !LOOKS_SCALAR.test(key) ? key : JSON.stringify(key);
      if (isMap(child) || Array.isArray(child)) {
        const empty = isMap(child)
          ? Object.keys(child).length === 0
          : (child as unknown[]).length === 0;
        lines.push(`${pad}${label}:`);
        if (empty) {
          lines[lines.length - 1] += isMap(child) ? " {}" : " []";
        } else {
          emit(child, indent + 1, lines);
        }
      } else {
        const rendered = scalar(child);
        if (rendered === "|-") {
          lines.push(`${pad}${label}: |-`);
          for (const line of String(child).split("\n")) {
            lines.push(`${pad}  ${line}`);
          }
        } else {
          lines.push(`${pad}${label}: ${rendered}`);
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (isMap(item) || Array.isArray(item)) {
        lines.push(`${pad}-`);
        emit(item, indent + 1, lines);
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }

  lines.push(`${pad}${scalar(value)}`);
}

export function toYaml(value: unknown): string {
  if (value === null || value === undefined) return "";
  const lines: string[] = [];
  emit(value, 0, lines);
  return lines.join("\n");
}
