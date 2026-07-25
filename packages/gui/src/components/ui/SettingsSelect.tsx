import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { AnchoredPopover } from "./AnchoredPopover";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Optional second line in the menu, not shown on the trigger. */
  description?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

/**
 * The choice control for settings rows: a compact trigger showing the current
 * value, opening a checked list.
 *
 * Native `<select>` was used in seven places and cannot be styled consistently
 * across the three themes — the popup is drawn by the OS, so on the `soft` theme
 * it arrived as a system-blue list next to desaturated chrome.
 */
export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  placeholder = "Select…",
  align = "right",
  className = "",
}: {
  value: T | undefined;
  options: SelectOption<T>[];
  onChange: (next: T) => void;
  /** Accessible name. Omit only when a `SettingsRow` label is wired via `id`. */
  label: string;
  disabled?: boolean;
  placeholder?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  const selectableIndexes = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  // Opening lands focus on the current value so arrow keys start from there,
  // not from the top of the list.
  useEffect(() => {
    if (!open) return;
    const initial = selected && !selected.disabled ? options.indexOf(selected) : selectableIndexes[0];
    setActiveIndex(initial ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.focus();
  }, [open, activeIndex]);

  const step = (dir: 1 | -1) => {
    if (!selectableIndexes.length) return;
    const at = selectableIndexes.indexOf(activeIndex);
    const next = at < 0 ? 0 : (at + dir + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[next]);
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Escape must dismiss the menu and stop there. These live inside a dialog whose
  // shell also listens for Escape on `document`, and the dialog's listener is
  // registered first — so without a capture-phase intercept, opening a select and
  // pressing Escape closed the entire settings surface.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const commit = (option: SelectOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-btn border border-scout-hairline-faint bg-scout-canvas px-2.5 text-caption font-medium text-scout-text transition-colors hover:border-scout-hairline hover:bg-scout-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        {selected?.icon}
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown size={13} className="shrink-0 text-scout-muted" />
      </button>

      <AnchoredPopover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        placement={align === "right" ? "bottom-end" : "bottom-start"}
        className="min-w-[180px] py-1"
      >
        <div ref={listRef} id={listId} role="listbox" aria-label={label}>
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-index={index}
                disabled={option.disabled}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => commit(option)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    step(1);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    step(-1);
                  } else if (e.key === "Home") {
                    e.preventDefault();
                    setActiveIndex(selectableIndexes[0]);
                  } else if (e.key === "End") {
                    e.preventDefault();
                    setActiveIndex(selectableIndexes[selectableIndexes.length - 1]);
                  } else if (e.key === "Tab") {
                    // A menu is not a tab stop; leaving it should close it.
                    close();
                  }
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-caption text-scout-text transition-colors hover:bg-scout-lift focus:bg-scout-lift focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex w-4 shrink-0 justify-center pt-0.5">
                  {isSelected && <Check size={13} className="text-scout-text" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium">
                    {option.icon}
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-micro leading-relaxed text-scout-muted">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}
