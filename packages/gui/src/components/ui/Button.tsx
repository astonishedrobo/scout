import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

type Variant = "filled" | "filledInverse" | "outlined" | "ghost";
type Surface = "canvas" | "panel" | "void";
type Accent = "void" | "white" | "peach" | "contrast" | "action";
type Size = "hero" | "default" | "compact";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  surface?: Surface;
  accent?: Accent;
  size?: Size;
  fullWidth?: boolean;
  /** Shows a spinner and disables the button. Sets aria-busy. */
  loading?: boolean;
  children: ReactNode;
}

// NOTE: `hero` and `default` hard-code rounded-xl rather than using the
// --radius-* tokens, so the `soft` theme's tighter corners don't reach them.
// Left as-is deliberately — switching to tokens changes the radius of every
// button in the app (12px -> 16px), which is a visual decision, not a fix.
const sizeClasses: Record<Size, string> = {
  hero: "px-6 py-3 text-[15px] rounded-xl",
  default: "px-5 py-2.5 text-sm rounded-xl",
  compact: "px-3 py-1.5 text-xs rounded-btn",
};

/*
 * `transition-all` would also animate width and padding, which visibly wobbles
 * when the label changes (notably when `loading` swaps a spinner in), so the
 * property list is explicit.
 * `active:scale` lives here rather than on one accent, so every variant has a
 * press state; `motion-reduce` drops it.
 */
const base =
  "inline-flex items-center justify-center gap-2 font-semibold tracking-[-0.01em] " +
  "transition-[background-color,border-color,color,opacity,box-shadow,transform] duration-fast " +
  "active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 " +
  "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30";

/*
 * Hover shifts the background tone rather than fading the whole element with
 * `hover:opacity-90` — dimming took the label with it, which read as "disabled"
 * instead of "hovered".
 */
const accentFilled: Record<Accent, string> = {
  void: "bg-scout-void text-scout-text-inverse hover:bg-scout-charcoal border border-transparent",
  // Literal white — used on the always-black void surface, so it must not
  // follow the theme's panel color.
  white: "bg-white text-scout-void hover:bg-white/90 border border-transparent",
  peach: "bg-scout-peach text-scout-void hover:bg-scout-peach/85 border border-transparent",
  // Ink pill: black in light mode, white in dark mode — Pika's primary CTA.
  contrast: "bg-scout-text text-scout-bg hover:bg-scout-text/90 border border-transparent",
  action: "bg-scout-action text-scout-void hover:bg-scout-action/85 border border-transparent",
};

const variants: Record<Variant, Record<Surface, string>> = {
  filled: {
    canvas: accentFilled.contrast,
    panel: accentFilled.contrast,
    void: accentFilled.white,
  },
  filledInverse: {
    canvas: accentFilled.white + " border border-scout-hairline-faint",
    panel: "bg-scout-canvas text-scout-text border border-scout-hairline hover:bg-scout-lift",
    void: accentFilled.white,
  },
  outlined: {
    canvas:
      "bg-transparent text-scout-text border border-scout-hairline hover:bg-scout-lift rounded-pill",
    panel:
      "bg-transparent text-scout-muted border border-scout-hairline-faint hover:text-scout-text hover:border-scout-hairline rounded-pill",
    // Always-black void surface — literal white, not theme tokens (text-inverse flips in dark mode).
    void:
      "bg-transparent text-white border border-white/40 hover:text-white hover:border-white/70 hover:bg-white/5 rounded-pill",
  },
  ghost: {
    canvas: "bg-transparent text-scout-muted hover:text-scout-text hover:bg-scout-lift rounded-btn",
    panel: "bg-transparent text-scout-muted hover:text-scout-text hover:bg-scout-lift rounded-btn",
    void: "bg-transparent text-white/70 hover:text-white hover:bg-white/5 rounded-btn",
  },
};

const spinnerSize: Record<Size, number> = { hero: 16, default: 14, compact: 12 };

export function Button({
  variant = "filled",
  surface = "panel",
  accent,
  size = "default",
  fullWidth,
  loading = false,
  className = "",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const variantClass =
    variant === "filled" && accent
      ? accentFilled[accent]
      : // Fall back to the default rather than throwing on an unknown variant:
        // a typo used to crash the whole panel on `variants[variant][surface]`.
        (variants[variant] ?? variants.filled)[surface];

  return (
    <button
      className={`${base} ${sizeClasses[size]} ${variantClass} ${fullWidth ? "w-full" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 size={spinnerSize[size]} className="animate-spin shrink-0" />}
      {children}
    </button>
  );
}
