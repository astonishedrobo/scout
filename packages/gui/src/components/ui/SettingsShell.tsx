import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { usePresence } from "../../hooks/usePresence";
import { useDialogShell } from "../../hooks/useDialogShell";
import { EXIT_MS } from "../../motion";

export interface NavSection {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Extra search terms, so "theme" finds Appearance. */
  keywords?: string[];
}

export interface NavGroup {
  /** Small muted heading above the group. Omit for an ungrouped run. */
  label?: string;
  sections: NavSection[];
}

/**
 * The settings surface: back affordance, grouped searchable nav, and one centered
 * content column.
 *
 * Settings and Admin each hand-rolled this and disagreed on everything, and both
 * then wrapped their content in `rounded-hero border bg-scout-panel/80` — the
 * outer card that made the page read as a window inside a window. There is no
 * card here: the column sits directly on the canvas and only row groups draw a
 * border.
 *
 * The nav is a list with `aria-current`, not a tablist: group headings inside a
 * `role="tablist"` break the pattern, and the sections are navigation rather than
 * tabs over one dataset. Arrow keys still move and select.
 */
export function SettingsShell({
  open,
  onClose,
  title,
  subtitle,
  groups,
  section,
  onSectionChange,
  status,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  groups: NavGroup[];
  section: string;
  onSectionChange: (next: string) => void;
  /** Transient "Saved" / error text, announced once for the whole surface. */
  status?: { message: string; tone: "info" | "error" } | null;
  children: ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const { mounted, state } = usePresence(open, EXIT_MS.panel);
  const [query, setQuery] = useState("");

  useDialogShell(open, overlayRef, onClose);

  // A section change is a navigation: send the content region back to the top,
  // or the new section opens scrolled into the middle of itself.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [section]);

  // Reopening should not inherit the last search.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        sections: group.sections.filter(
          (s) =>
            s.label.toLowerCase().includes(q) ||
            (s.keywords ?? []).some((k) => k.toLowerCase().includes(q)),
        ),
      }))
      .filter((group) => group.sections.length > 0);
  }, [groups, query]);

  const flat = useMemo(() => filtered.flatMap((g) => g.sections), [filtered]);

  const onNavKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key) || flat.length === 0) return;
    e.preventDefault();
    const at = flat.findIndex((s) => s.id === section);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? flat.length - 1
          : (at + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length;
    onSectionChange(flat[next].id);
    navRef.current?.querySelector<HTMLElement>(`[data-section-id="${flat[next].id}"]`)?.focus();
  };

  if (!mounted) return null;

  const itemClass = (active: boolean) =>
    `flex w-full items-center gap-2.5 rounded-btn px-2.5 py-1.5 text-left text-label transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
      active
        ? "bg-scout-lift font-medium text-scout-text"
        : "text-scout-muted hover:bg-scout-lift/60 hover:text-scout-text"
    }`;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className={`fixed inset-0 z-50 flex flex-col bg-scout-canvas outline-none md:flex-row ${
        state === "exiting" ? "animate-fade-out pointer-events-none" : "animate-enter"
      }`}
    >
      {/* Mobile: back + a horizontal section strip, since a 224px rail would
          take most of a 360px viewport. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-scout-hairline-faint px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 self-start rounded-btn px-2 py-1.5 text-label text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
        >
          <ArrowLeft size={16} />
          Back to app
        </button>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {groups.flatMap((g) => g.sections).map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => onSectionChange(s.id)}
              className={`shrink-0 rounded-btn px-2.5 py-1.5 text-caption transition-colors ${
                s.id === section
                  ? "bg-scout-lift font-medium text-scout-text"
                  : "text-scout-muted hover:text-scout-text"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <nav
        ref={navRef}
        aria-label="Settings sections"
        onKeyDown={onNavKeyDown}
        className="hidden w-[224px] shrink-0 flex-col overflow-y-auto border-r border-scout-hairline-faint px-3 py-3 md:flex"
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-2 flex items-center gap-2 rounded-btn px-2.5 py-1.5 text-label text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30"
        >
          <ArrowLeft size={16} />
          Back to app
        </button>

        <div className="relative mb-3">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-scout-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="h-8 w-full rounded-btn border border-scout-hairline-faint bg-scout-panel/40 pl-7 pr-2 text-caption text-scout-text placeholder:text-scout-muted focus:border-scout-text/30 focus:outline-none focus:ring-1 focus:ring-scout-text/20"
          />
        </div>

        {filtered.length === 0 && (
          <p className="px-2.5 py-2 text-caption text-scout-muted">No matching settings.</p>
        )}

        <div className="space-y-4">
          {filtered.map((group, i) => (
            <div key={group.label ?? `group-${i}`}>
              {group.label && (
                <p className="px-2.5 pb-1 text-micro font-medium text-scout-muted/60">{group.label}</p>
              )}
              <ul className="space-y-0.5">
                {group.sections.map((s) => {
                  const active = s.id === section;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        data-section-id={s.id}
                        aria-current={active ? "page" : undefined}
                        // One tab stop for the whole nav; arrows move within it.
                        tabIndex={active ? 0 : -1}
                        onClick={() => onSectionChange(s.id)}
                        className={itemClass(active)}
                      >
                        {s.icon && <span className="shrink-0 text-scout-muted">{s.icon}</span>}
                        <span className="truncate">{s.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        {/* Widens with the window instead of sitting at one narrow measure: 560px
            reads cramped on a desktop display, and rows with a label, a
            description and a control need the room. Capped so long descriptions
            keep a readable line length. */}
        <div className="density-surface mx-auto w-full max-w-[680px] px-5 sm:px-8 xl:max-w-[840px]">
          <header className="mb-7">
            <h1 className="text-body font-semibold tracking-[-0.02em] text-scout-text">{title}</h1>
            {subtitle && <p className="mt-1 text-caption text-scout-muted">{subtitle}</p>}
          </header>

          {/* One live region for the whole surface. The old save bar announced
              nothing, so a failed save was silent. */}
          <p
            role={status?.tone === "error" ? "alert" : "status"}
            aria-live="polite"
            className={`min-h-[18px] text-caption ${
              status?.tone === "error" ? "text-scout-error" : "text-scout-muted"
            } ${status ? "mb-4" : ""}`}
          >
            {status?.message ?? ""}
          </p>

          <div className="density-sections">{children}</div>
        </div>
      </div>
    </div>
  );
}
