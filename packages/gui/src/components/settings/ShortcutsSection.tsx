import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { EmptyState, Kbd, SettingsGroup, SettingsRow } from "../ui";
import { SHORTCUTS, shortcutKeys, type ShortcutDef } from "../../shortcuts";

/**
 * Keyboard shortcuts.
 *
 * The list comes from `shortcuts.ts`, which is also what registers the live
 * accelerators — so what is documented here is what actually fires, formatted for
 * the current platform. Rebinding needs a backend; the search does not, so it
 * ships now.
 */
export function ShortcutsSection() {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? SHORTCUTS.filter(
          (s) =>
            s.desc.toLowerCase().includes(q) || shortcutKeys(s).toLowerCase().includes(q),
        )
      : SHORTCUTS;
    // Preserve the registry's order rather than sorting group names.
    const byGroup = new Map<string, ShortcutDef[]>();
    for (const shortcut of matches) {
      const bucket = byGroup.get(shortcut.group);
      if (bucket) bucket.push(shortcut);
      else byGroup.set(shortcut.group, [shortcut]);
    }
    return [...byGroup.entries()];
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
          className="h-8 w-full rounded-btn border border-scout-hairline-faint bg-scout-panel/40 pl-8 pr-3 text-caption text-scout-text placeholder:text-scout-muted focus:border-scout-text/30 focus:outline-none focus:ring-1 focus:ring-scout-text/20"
        />
      </div>

      {groups.length === 0 ? (
        <SettingsGroup label="Shortcuts">
          <EmptyState size="sm" title="No matching shortcuts" body={`Nothing matches “${query}”.`} />
        </SettingsGroup>
      ) : (
        groups.map(([group, shortcuts], index) => (
          <SettingsGroup
            key={group}
            label={group}
            // Said once, not repeated above every group.
            description={index === 0 ? "These are fixed for now." : undefined}
          >
            {shortcuts.map((s) => (
              <SettingsRow key={s.id} label={s.desc} control={<Kbd>{shortcutKeys(s)}</Kbd>} />
            ))}
          </SettingsGroup>
        ))
      )}
    </>
  );
}
