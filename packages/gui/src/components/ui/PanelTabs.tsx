import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Plus, X } from "lucide-react";

export interface PanelTab {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Full text for the tooltip, when the label is a truncated short form. */
  title?: string;
}

/**
 * The right panel's tab strip.
 *
 * Implements the WAI-ARIA tab pattern with closable tabs: roving tabindex, arrow
 * keys with wrap, Home/End, and Delete/Backspace to close. The `×` is
 * `tabIndex={-1}` on purpose — one tab stop per tab, so Tab does not have to walk
 * through two controls per open surface to leave the strip.
 *
 * `SubTabs` deliberately is not reused here: that is a pill filter over one
 * dataset with counts and a scoped search, and its tabs cannot be closed.
 */
export function PanelTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onAdd,
  addRef,
  addLabel = "Open a panel",
  trailing,
}: {
  tabs: PanelTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onAdd?: () => void;
  /** Anchor for the launcher popover the `+` opens. */
  addRef?: RefObject<HTMLButtonElement>;
  addLabel?: string;
  /** Pane-level controls (expand, close) pinned to the right end. */
  trailing?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Activating a tab that is scrolled out of the strip must bring it into view,
  // or a shortcut can switch to a tab you cannot see.
  useEffect(() => {
    if (!activeKey) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      if (!activeKey) return;
      event.preventDefault();
      onClose(activeKey);
      return;
    }
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key) || tabs.length === 0) return;
    event.preventDefault();
    const at = tabs.findIndex((t) => t.key === activeKey);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onActivate(tabs[next].key);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(tabs[next].key)}"]`)
      ?.focus();
  };

  return (
    <div className="flex h-[46px] shrink-0 items-center gap-1 border-b border-scout-hairline-faint bg-scout-canvas pl-2 pr-2">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Panel tabs"
        onKeyDown={onKeyDown}
        className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              className={`group flex h-8 shrink-0 items-center rounded-btn transition-colors ${
                active
                  ? "bg-scout-lift text-scout-text"
                  : "text-scout-muted hover:bg-scout-lift/60 hover:text-scout-text"
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                data-tab-key={tab.key}
                tabIndex={active ? 0 : -1}
                title={tab.title ?? tab.label}
                onClick={() => onActivate(tab.key)}
                // Middle-click closes, as it does on every other tab strip.
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    onClose(tab.key);
                  }
                }}
                className="flex h-8 min-w-0 max-w-[11rem] items-center gap-1.5 rounded-btn pl-2.5 pr-1 text-caption font-medium outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
              >
                {tab.icon && <span className="flex shrink-0 items-center">{tab.icon}</span>}
                <span className="truncate">{tab.label}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label}`}
                onClick={() => onClose(tab.key)}
                // Present for the active tab, revealed on hover or keyboard
                // focus for the others, so the strip stays quiet at rest.
                // `hover-reveal` also keeps it visible on touch, where there is
                // no hover to reveal it with; `group-focus-within` covers the
                // keyboard case, since the × itself is never focused.
                className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-btn text-scout-muted transition-colors hover:bg-scout-muted/20 hover:text-scout-text ${
                  active ? "" : "hover-reveal group-focus-within:opacity-100"
                }`}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        {onAdd && (
          <button
            ref={addRef}
            type="button"
            onClick={onAdd}
            aria-label={addLabel}
            title={addLabel}
            aria-haspopup="menu"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
          >
            <Plus size={15} />
          </button>
        )}
      </div>

      {trailing && <div className="flex shrink-0 items-center gap-0.5">{trailing}</div>}
    </div>
  );
}
