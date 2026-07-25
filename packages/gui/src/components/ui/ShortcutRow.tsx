/**
 * The key cap, on its own.
 *
 * Kept separate from `ShortcutRow` because the settings section needs the cap
 * without the row: when the styling lived only inside the row, a third caller
 * copied the class string, which is how the first two drifted.
 */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="min-w-[40px] shrink-0 rounded-btn border border-scout-hairline bg-scout-input-bg px-2 py-1 text-center font-mono text-caption font-medium text-scout-text shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]">
      {children}
    </kbd>
  );
}

/**
 * One keyboard-shortcut row.
 *
 * HelpDialog and SettingsPanel each rendered their own, and they had already
 * diverged: different row padding and a `min-w`/centering difference on the
 * `<kbd>`, for the same list of shortcuts shown in two places.
 */
export function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="min-w-0 text-label font-medium text-scout-text/70">{desc}</span>
      <Kbd>{keys}</Kbd>
    </div>
  );
}
