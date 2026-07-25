import { Search } from "lucide-react";

export interface SubTab<T extends string> {
  id: T;
  label: string;
  /** Rendered as a muted count beside the label. `0` still shows. */
  count?: number;
}

/**
 * Pill sub-tabs with counts, optionally paired with a search field scoped to the
 * active tab.
 *
 * Implements the WAI-ARIA tab pattern: roving tabindex, arrow keys with wrap,
 * Home/End, and selection following focus — the same behaviour the settings nav
 * uses, so the two never disagree.
 */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
  search,
  className = "",
}: {
  tabs: SubTab<T>[];
  value: T;
  onChange: (next: T) => void;
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
  };
  className?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === value);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    const el = e.currentTarget.querySelector<HTMLElement>(`[data-subtab-id="${tabs[next].id}"]`);
    el?.focus();
  };

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      <div role="tablist" aria-label="Sections" onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
        {tabs.map((tab) => {
          const active = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-subtab-id={tab.id}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-caption font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
                active
                  ? "bg-scout-lift text-scout-text"
                  : "text-scout-muted hover:bg-scout-lift/60 hover:text-scout-text"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className={active ? "text-scout-muted" : "text-scout-muted/70"}>{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {search && (
        <div className="relative min-w-[180px] flex-1 sm:max-w-[220px] sm:flex-none">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-scout-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? "Search"}
            aria-label={search.placeholder ?? "Search"}
            className="h-8 w-full rounded-btn border border-scout-hairline-faint bg-scout-canvas pl-7 pr-2.5 text-caption text-scout-text placeholder:text-scout-muted focus:border-scout-text/30 focus:outline-none focus:ring-1 focus:ring-scout-text/20"
          />
        </div>
      )}
    </div>
  );
}
