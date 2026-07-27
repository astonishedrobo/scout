import { splitPath } from "./pathDisplay";

/**
 * Path that truncates its directory, never its filename.
 *
 * The directory gets `truncate` and is allowed to shrink; the filename is
 * `shrink-0`, so it survives at any width.
 */
export function PathLabel({ path, className = "" }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={`flex min-w-0 items-baseline ${className}`} title={path}>
      {dir && <span className="truncate text-scout-muted/80">{dir}</span>}
      <span className="shrink-0">{name}</span>
    </span>
  );
}
