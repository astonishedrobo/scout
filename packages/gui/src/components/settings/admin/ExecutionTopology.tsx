import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * The path a request takes, with live status on each hop.
 *
 * Its job is to answer two questions no list of numbers answers well: where is
 * the bottleneck, and is isolation actually on. Both are spatial — you read them
 * off the shape.
 *
 * Hand-rolled from flex and lucide chevrons rather than mermaid. Mermaid renders
 * author-written text diagrams, so it cannot colour a node from live data or
 * take colour from the active theme, and it would pull a ~600kB async chunk into
 * an admin page to draw five boxes. This draws from `--scout-*` tokens, so it is
 * correct in all three themes for free.
 *
 * Below `md` the row becomes a vertical stack; the chevrons rotate to point
 * down. Screen readers get an ordered list, which is what this actually is.
 */

export type NodeTone = "ok" | "busy" | "warning" | "danger" | "idle";

export interface TopologyNode {
  id: string;
  label: string;
  /** The one number that matters for this hop. */
  value: ReactNode;
  /** What that number means, in three or four words. */
  detail?: string;
  tone: NodeTone;
  /** Reads the state in words, for the accessible description. */
  statusText: string;
}

const dots: Record<NodeTone, string> = {
  ok: "bg-scout-success",
  busy: "bg-scout-lavender",
  warning: "bg-scout-warning",
  danger: "bg-scout-error",
  idle: "bg-scout-muted/50",
};

const borders: Record<NodeTone, string> = {
  ok: "border-scout-hairline-faint",
  busy: "border-scout-lavender/40",
  warning: "border-scout-warning/40",
  danger: "border-scout-error/50",
  idle: "border-scout-hairline-faint",
};

export function ExecutionTopology({ nodes }: { nodes: TopologyNode[] }) {
  return (
    <div className="px-4 py-4">
      <ol className="flex flex-col items-stretch gap-1.5 md:flex-row md:items-center">
        {nodes.map((node, i) => (
          <li key={node.id} className="flex min-w-0 items-center gap-1.5 md:flex-1">
            <div
              className={`min-w-0 flex-1 rounded-control border bg-scout-panel/40 px-2.5 py-2 ${borders[node.tone]}`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-pill ${dots[node.tone]}`}
                  aria-hidden="true"
                />
                <span className="truncate text-micro font-medium uppercase tracking-[0.06em] text-scout-muted">
                  {node.label}
                </span>
              </div>
              <p className="mt-1 truncate font-mono text-caption tabular-nums text-scout-text">
                {node.value}
              </p>
              {node.detail && (
                <p className="mt-0.5 truncate text-micro text-scout-muted">{node.detail}</p>
              )}
              {/* The visual dot carries no meaning without this. */}
              <span className="sr-only">Status: {node.statusText}</span>
            </div>
            {i < nodes.length - 1 && (
              <ChevronRight
                size={14}
                aria-hidden="true"
                className="shrink-0 rotate-90 text-scout-muted/60 md:rotate-0"
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
