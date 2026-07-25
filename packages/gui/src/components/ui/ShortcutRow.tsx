/**
 * The key cap, on its own.
 *
 * Kept separate from `ShortcutRow` because the settings section needs the cap
 * without the row: when the styling lived only inside the row, a third caller
 * copied the class string, which is how the first two drifted.
 */
export function Kbd({
  children,
  compact = false,
}: {
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <kbd className={`${compact ? "min-w-0 px-1.5 py-0.5 text-micro" : "min-w-[40px] px-2 py-1 text-caption"} shrink-0 rounded-btn border border-scout-hairline-faint bg-scout-input-bg/70 text-center font-mono font-medium text-scout-text`}>
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
