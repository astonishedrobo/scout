/**
 * Loading placeholders for waits whose shape is known in advance.
 *
 * Use these instead of a spinner when the eventual content has a predictable
 * layout (a list of session rows, a file tree) — the placeholder holds the
 * space, so content does not jump in. Keep spinners for indeterminate,
 * shapeless waits (a request in flight behind a button).
 *
 * The sweep animation and its reduced-motion fallback live on `.skeleton` in
 * globals.css.
 */

interface LineProps {
  /** Tailwind width class, e.g. "w-2/3". Defaults to full width. */
  width?: string;
  className?: string;
}

function Line({ width = "w-full", className = "" }: LineProps) {
  return <div className={`skeleton h-3 ${width} ${className}`} />;
}

interface BlockProps {
  className?: string;
}

function Block({ className = "" }: BlockProps) {
  return <div className={`skeleton ${className}`} />;
}

interface ListProps {
  /** How many placeholder rows to show. */
  rows?: number;
  className?: string;
}

/**
 * A stack of two-line rows, shaped like a session/file list entry.
 * Widths alternate so the block does not read as a solid rectangle.
 */
function List({ rows = 5, className = "" }: ListProps) {
  const widths = ["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-3/4"];
  return (
    <div className={`space-y-0.5 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="px-2.5 py-2">
          <Line width={widths[i % widths.length]} />
          <Line width="w-16" className="mt-1.5 h-2" />
        </div>
      ))}
    </div>
  );
}

export const Skeleton = { Line, Block, List };
