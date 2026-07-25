import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { EmptyState, Kbd, SettingsGroup, SettingsRow } from "../ui";
import { SHORTCUTS } from "../../appMeta";

/**
 * Keyboard shortcuts.
 *
 * The list itself is `SHORTCUTS` in appMeta — the single source shared with
 * HelpDialog, so the two cannot drift. Rebinding needs a backend; the search and
 * the rows do not, so they ship now.
 */
export function ShortcutsSection() {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUTS;
    return SHORTCUTS.filter(
      (s) => s.desc.toLowerCase().includes(q) || s.keys.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <>
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-scout-muted"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          className="h-9 w-full rounded-card border border-scout-hairline-faint bg-scout-panel/40 pl-9 pr-3 text-label text-scout-text placeholder:text-scout-muted focus:border-scout-text/30 focus:outline-none focus:ring-1 focus:ring-scout-text/20"
        />
      </div>

      <SettingsGroup label="Shortcuts" description="These are fixed for now.">
        {matches.length === 0 ? (
          <EmptyState size="sm" title="No matching shortcuts" body={`Nothing matches “${query}”.`} />
        ) : (
          matches.map((s) => (
            <SettingsRow
              key={s.keys}
              label={s.desc}
              control={<Kbd>{s.keys}</Kbd>}
            />
          ))
        )}
      </SettingsGroup>
    </>
  );
}
