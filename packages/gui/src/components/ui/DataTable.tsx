import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { EmptyState } from "./EmptyState";

/**
 * A sortable, searchable table.
 *
 * This is the primitive whose absence made every admin page a vertical list of
 * label→value pairs: with only `SettingsRow` available, anything with more than
 * one fact per entity had nowhere to go. Users, shared files, MCP tools, MCP
 * access, live sessions and the execution audit log are all the same shape, so
 * this is built once and properly.
 *
 * CSS grid rather than `<table>` for layout, but the real table roles are kept —
 * a screen reader still hears rows and columns, and `aria-sort` announces the
 * current order.
 *
 * Draws no outer border: `SettingsGroup` owns that. Overflows horizontally
 * inside itself so a narrow viewport never scrolls the page sideways.
 */

export interface Column<Row> {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  /** Grid track for this column. Defaults to `minmax(0,1fr)`. */
  width?: string;
  /** Cell content. Defaults to the row's value at `key`, stringified. */
  render?: (row: Row) => ReactNode;
  /**
   * Comparable value for sorting. Presence of this makes the header sortable —
   * a header you can click must have a defined order, so the two travel together.
   */
  sortValue?: (row: Row) => string | number;
  /** Text matched by the search field. */
  searchValue?: (row: Row) => string;
}

type SortState = { key: string; dir: "asc" | "desc" } | null;

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  search,
  initialSort,
  empty,
  caption,
  rowActions,
  onRowClick,
  className = "",
}: {
  columns: Column<Row>[];
  rows: Row[];
  getRowId: (row: Row) => string;
  /** Enables the search field. Placeholder text; matching uses `searchValue`. */
  search?: { placeholder?: string };
  initialSort?: { key: string; dir: "asc" | "desc" };
  /** Shown when `rows` is empty. Filtering to nothing shows a no-results state. */
  empty: ReactNode;
  /** Totals line under the table — "12 users · 3 admins". */
  caption?: ReactNode;
  /** Trailing action cell, sized to content and never sorted. */
  rowActions?: (row: Row) => ReactNode;
  onRowClick?: (row: Row) => void;
  className?: string;
}) {
  const [sort, setSort] = useState<SortState>(initialSort ?? null);
  const [query, setQuery] = useState("");

  const searchable = useMemo(() => columns.filter((c) => c.searchValue), [columns]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let out = rows;

    if (needle && searchable.length > 0) {
      out = out.filter((row) =>
        searchable.some((c) => c.searchValue!(row).toLowerCase().includes(needle)),
      );
    }

    if (sort) {
      const column = columns.find((c) => c.key === sort.key);
      if (column?.sortValue) {
        const factor = sort.dir === "asc" ? 1 : -1;
        // Copy before sorting: `rows` is the caller's array and mutating it
        // would reorder their state as a side effect of rendering.
        out = [...out].sort((a, b) => {
          const av = column.sortValue!(a);
          const bv = column.sortValue!(b);
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
          return String(av).localeCompare(String(bv), undefined, { numeric: true }) * factor;
        });
      }
    }

    return out;
  }, [rows, columns, searchable, query, sort]);

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  const template = [
    ...columns.map((c) => c.width ?? "minmax(0,1fr)"),
    ...(rowActions ? ["max-content"] : []),
  ].join(" ");

  const filteredToNothing = rows.length > 0 && visible.length === 0;

  return (
    <div className={className}>
      {search && searchable.length > 0 && (
        <div className="relative px-4 pb-2 pt-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-[26px] top-1/2 -translate-y-1/2 text-scout-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={search.placeholder ?? "Search"}
            aria-label={search.placeholder ?? "Search"}
            className="h-8 w-full rounded-btn border border-scout-hairline-faint bg-scout-canvas pl-7 pr-2.5 text-caption text-scout-text placeholder:text-scout-muted focus:border-scout-text/30 focus:outline-none focus:ring-1 focus:ring-scout-text/20 sm:max-w-[260px]"
          />
        </div>
      )}

      {rows.length === 0 ? (
        <div className="px-4">{empty}</div>
      ) : (
        <div className="overflow-x-auto">
          {/* min-w keeps columns legible; the wrapper scrolls rather than the page. */}
          <div role="table" className="min-w-[520px]">
            <div
              role="row"
              className="grid items-center gap-3 border-b border-scout-hairline-faint px-4 pb-1.5"
              style={{ gridTemplateColumns: template }}
            >
              {columns.map((column) => {
                const sorted = sort?.key === column.key;
                const headerText = (
                  <span className="truncate text-micro font-semibold uppercase tracking-[0.06em] text-scout-muted">
                    {column.header}
                  </span>
                );
                return (
                  <div
                    key={column.key}
                    role="columnheader"
                    aria-sort={sorted ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`min-w-0 ${column.align === "right" ? "text-right" : ""}`}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={`inline-flex max-w-full items-center gap-1 rounded-btn transition-colors hover:text-scout-text focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
                          column.align === "right" ? "flex-row-reverse" : ""
                        }`}
                      >
                        {headerText}
                        {sorted &&
                          (sort!.dir === "asc" ? (
                            <ArrowUp size={11} className="shrink-0 text-scout-text" aria-hidden="true" />
                          ) : (
                            <ArrowDown size={11} className="shrink-0 text-scout-text" aria-hidden="true" />
                          ))}
                      </button>
                    ) : (
                      headerText
                    )}
                  </div>
                );
              })}
              {rowActions && <div role="columnheader" aria-label="Actions" />}
            </div>

            {filteredToNothing ? (
              <EmptyState
                size="sm"
                title="No matches"
                body={`Nothing matches “${query.trim()}”.`}
              />
            ) : (
              <div role="rowgroup">
                {visible.map((row) => (
                  <div
                    key={getRowId(row)}
                    role="row"
                    {...(onRowClick
                      ? {
                          tabIndex: 0,
                          onClick: () => onRowClick(row),
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(row);
                            }
                          },
                        }
                      : {})}
                    className={`grid items-center gap-3 border-b border-scout-hairline-faint/50 px-4 py-2 text-caption text-scout-text last:border-b-0 ${
                      onRowClick
                        ? "cursor-pointer transition-colors hover:bg-scout-lift/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scout-text/30"
                        : ""
                    }`}
                    style={{ gridTemplateColumns: template }}
                  >
                    {columns.map((column) => (
                      <div
                        key={column.key}
                        role="cell"
                        className={`min-w-0 ${column.align === "right" ? "text-right" : ""}`}
                      >
                        {column.render
                          ? column.render(row)
                          : String((row as Record<string, unknown>)[column.key] ?? "—")}
                      </div>
                    ))}
                    {rowActions && (
                      <div role="cell" className="flex items-center justify-end gap-1">
                        {rowActions(row)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {caption && rows.length > 0 && (
        <p className="px-4 pt-2 text-micro text-scout-muted">
          {caption}
          {filteredToNothing || visible.length !== rows.length
            ? ` · showing ${visible.length} of ${rows.length}`
            : ""}
        </p>
      )}
    </div>
  );
}
