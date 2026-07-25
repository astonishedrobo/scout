import { useEffect, useRef, type ReactNode } from "react";
import { Kbd } from "./ui/ShortcutRow";
import { keysFor, type ShortcutId } from "../shortcuts";

export interface LauncherItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** Pulls the chip text from the shortcut registry — never hardcode keys here. */
  shortcut?: ShortcutId;
  /** Shown instead of the chip when the item cannot be opened. */
  hint?: string;
  badge?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * What can go in the right panel.
 *
 * Renders the same list two ways: as the pane's empty state, and as the menu the
 * `+` in the tab strip opens. Before this there was no way to discover the panel
 * at all — entry was two buttons in the chat header.
 *
 * Only surfaces that exist are listed. There is no terminal (no PTY, no
 * WebSocket, no xterm anywhere — "terminal" here is a background task type shown
 * inside the agents panel) and no browser, so neither appears, not even disabled.
 */
export function PanelLauncher({
  items,
  variant = "list",
  onDismiss,
}: {
  items: LauncherItem[];
  variant?: "list" | "menu";
  /** Called after a selection, and on Escape, when rendered as a menu. */
  onDismiss?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const enabled = items.filter((item) => !item.disabled);

  // As a menu, focus lands on the first actionable row so the keyboard works
  // immediately. As the empty state it must not steal focus from the composer.
  useEffect(() => {
    if (variant !== "menu") return;
    containerRef.current?.querySelector<HTMLElement>("[data-launcher-item]:not([disabled])")?.focus();
  }, [variant]);

  const step = (from: HTMLElement, direction: 1 | -1) => {
    const nodes = [
      ...(containerRef.current?.querySelectorAll<HTMLElement>(
        "[data-launcher-item]:not([disabled])",
      ) ?? []),
    ];
    if (nodes.length === 0) return;
    const at = nodes.indexOf(from);
    nodes[(at + direction + nodes.length) % nodes.length].focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.target as HTMLElement, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nodes = [
        ...(containerRef.current?.querySelectorAll<HTMLElement>(
          "[data-launcher-item]:not([disabled])",
        ) ?? []),
      ];
      (event.key === "Home" ? nodes[0] : nodes[nodes.length - 1])?.focus();
    }
  };

  const rows = (
    <div
      ref={containerRef}
      role={variant === "menu" ? "menu" : undefined}
      onKeyDown={onKeyDown}
      className={`overflow-hidden border border-scout-hairline-faint bg-scout-panel/95 shadow-pop ${
        variant === "menu" ? "rounded-card" : "rounded-[14px]"
      }`}
    >
      {items.map((item) => {
        const keys = item.shortcut ? keysFor(item.shortcut) : undefined;
        return (
          <button
            key={item.id}
            type="button"
            data-launcher-item
            role={variant === "menu" ? "menuitem" : undefined}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onDismiss?.();
            }}
            className="group flex min-h-11 w-full items-center gap-3 border-b border-scout-hairline-faint px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-scout-lift/75 focus:bg-scout-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scout-text/25 disabled:cursor-not-allowed disabled:bg-transparent disabled:opacity-45"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-scout-muted transition-colors group-hover:bg-scout-input-bg group-hover:text-scout-text">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-label font-medium text-scout-text">
              {item.label}
            </span>
            {item.badge}
            {item.disabled && item.hint ? (
              <span className="shrink-0 text-micro text-scout-muted">{item.hint}</span>
            ) : (
              keys && <Kbd>{keys}</Kbd>
            )}
          </button>
        );
      })}
      {enabled.length === 0 && (
        <p className="px-3 py-2.5 text-caption text-scout-muted">Nothing to open yet.</p>
      )}
    </div>
  );

  if (variant === "menu") return <div className="w-[286px] p-1.5">{rows}</div>;

  return (
    <div className="flex h-full items-center justify-center px-6 py-8">
      <div className="w-full max-w-[360px]">
        <div className="mb-3 px-1">
          <p className="text-label font-semibold tracking-[-0.01em] text-scout-text">
            Open a panel
          </p>
          <p className="mt-0.5 text-caption text-scout-muted">
            Choose a workspace view to keep alongside your conversation.
          </p>
        </div>
        {rows}
      </div>
    </div>
  );
}
