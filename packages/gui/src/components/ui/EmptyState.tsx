import type { ReactNode } from "react";

/**
 * Consistent empty / no-results state. There were eight of these across the
 * panels with five paddings and three body sizes, ranging from a full
 * art-plus-CTA treatment down to a bare one-line sentence.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  size = "md",
  className = "",
}: {
  icon?: ReactNode;
  title?: ReactNode;
  body?: ReactNode;
  /** Primary recovery action, when there is one. */
  action?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 text-center ${
        size === "sm" ? "px-3 py-6" : "px-6 py-10"
      } ${className}`}
    >
      {icon && <span className="text-scout-muted/70">{icon}</span>}
      {title && <p className="text-label font-medium text-scout-text">{title}</p>}
      {body && <p className="text-caption leading-relaxed text-scout-muted">{body}</p>}
      {action}
    </div>
  );
}
