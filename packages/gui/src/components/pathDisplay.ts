/**
 * Split a workspace path into its directory and filename.
 *
 * Paths are shown in narrow columns and were end-truncated with `truncate`,
 * which throws away the filename — the one part that identifies the file — and
 * keeps the directory prefix that is usually the same for every row. Rendering
 * the two parts separately lets the directory shrink while the filename stays.
 */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  if (at < 0) return { dir: "", name: path };
  return { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
