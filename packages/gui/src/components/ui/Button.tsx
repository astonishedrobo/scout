import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

type Variant = "filled" | "filledInverse" | "outlined" | "ghost";
type Surface = "canvas" | "panel" | "void";
type Accent = "void" | "white" | "peach" | "contrast" | "action";
/**
 * Semantic tone for consequential choices (approve / deny). Added because the
 * approval surfaces hand-rolled tinted pills — the app's most consequential
 * buttons were the ones not using the primitive.
 */
type Tone = "success" | "danger" | "info";
type Size = "hero" | "default" | "compact";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  surface?: Surface;
  accent?: Accent;
  /** Overrides variant colours; keeps the variant's geometry. */
  tone?: Tone;
  size?: Size;
  fullWidth?: boolean;
  /** Shows a spinner and disables the button. Sets aria-busy. */
  loading?: boolean;
  children: ReactNode;
}

// Radii come from the --radius-* tokens, so buttons follow the theme: 16/10 in
// light and dark, 12/8 in `soft`. (These used to be fixed Tailwind radii, which
// froze every button at one theme's value.)
const sizeClasses: Record<Size, string> = {
  hero: "px-6 py-3 text-prose rounded-card",
  default: "px-5 py-2.5 text-label rounded-card",
  compact: "px-3 py-1.5 text-caption rounded-btn",
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

const tones: Record<Tone, string> = {
  success:
    "bg-scout-success-muted text-scout-success border border-scout-success/15 hover:border-scout-success/30",
  danger:
    "bg-scout-error-muted text-scout-error border border-scout-error/15 hover:border-scout-error/30",
  info: "bg-scout-lift/80 text-scout-cyan border border-scout-hairline-faint hover:bg-scout-lift",
};

const spinnerSize: Record<Size, number> = { hero: 16, default: 14, compact: 12 };

export function Button({
  variant = "filled",
  surface = "panel",
  accent,
  tone,
  size = "default",
  fullWidth,
  loading = false,
  className = "",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const variantClass = tone
    ? tones[tone]
    : variant === "filled" && accent
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
