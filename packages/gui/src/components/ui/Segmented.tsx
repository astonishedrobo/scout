/**
 * Two or three exclusive options, shown together.
 *
 * A radiogroup rather than a row of buttons: the options are mutually exclusive
 * and one is always chosen, so arrow keys must move *and* select, and assistive
 * tech needs to hear "1 of 2".
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className = "",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const move = (dir: 1 | -1) => {
    const at = options.findIndex((o) => o.value === value);
    const next = (at + dir + options.length) % options.length;
    onChange(options[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex items-center gap-0.5 rounded-btn border border-scout-hairline-faint bg-scout-canvas p-0.5 ${
        disabled ? "pointer-events-none opacity-50" : ""
      } ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: the group is one tab stop, arrows move within it.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              }
            }}
            className={`h-7 rounded-btn px-2.5 text-caption font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
              active
                ? "bg-scout-lift text-scout-text"
                : "text-scout-muted hover:text-scout-text"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
