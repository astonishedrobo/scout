/**
 * On/off switch with the switch role, a real 32px hit area, and a label.
 *
 * These were plain `<button>`s (40x20 and 36x20) with no `role="switch"` and no
 * `aria-checked`, so assistive tech announced them as buttons of unknown state.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name — the switch itself carries no visible text. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      // The 32px box comes from the padding; the track stays 36x20.
      className="inline-flex h-8 shrink-0 items-center p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 disabled:pointer-events-none"
    >
      <span
        className={`flex h-5 w-9 items-center rounded-pill transition-colors ${
          // A disabled switch keeps its on/off reading but loses its colour, so
          // it is legible as "set, but not yours to change" rather than just dim.
          disabled
            ? checked
              ? "bg-scout-muted/40"
              : "bg-scout-hairline-faint"
            : checked
              ? "bg-scout-success"
              : "bg-scout-hairline"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-pill transition-transform ${
            disabled ? "bg-white/60" : "bg-white"
          } ${checked ? "translate-x-4" : "translate-x-0.5"}`}
        />
      </span>
    </button>
  );
}
