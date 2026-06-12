import type { ButtonHTMLAttributes, ReactNode } from "react";

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
  children: ReactNode;
}

const sizeClasses: Record<Size, string> = {
  hero: "px-6 py-3 text-[15px] rounded-pill",
  default: "px-5 py-2.5 text-sm rounded-pill",
  compact: "px-3 py-1.5 text-xs rounded-btn",
};

const base =
  "inline-flex items-center justify-center gap-2 font-semibold tracking-[-0.01em] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30";

const accentFilled: Record<Accent, string> = {
  void: "bg-scout-void text-scout-text-inverse hover:opacity-90 border border-transparent",
  // Literal white — used on the always-black void surface, so it must not
  // follow the theme's panel color.
  white: "bg-white text-scout-void hover:opacity-90 border border-transparent",
  peach: "bg-scout-peach text-scout-void hover:opacity-90 border border-transparent",
  // Ink pill: black in light mode, white in dark mode — Pika's primary CTA.
  contrast:
    "bg-scout-text text-scout-bg hover:opacity-90 active:scale-[0.98] border border-transparent",
  action: "bg-scout-action text-scout-void hover:opacity-90 border border-transparent",
};

const variants: Record<Variant, Record<Surface, string>> = {
  filled: {
    canvas: accentFilled.contrast,
    panel: accentFilled.contrast,
    void: accentFilled.white,
  },
  filledInverse: {
    canvas: accentFilled.white + " border border-scout-hairline-faint",
    panel: "bg-scout-canvas text-scout-text border border-scout-hairline hover:opacity-90",
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

export function Button({
  variant = "filled",
  surface = "panel",
  accent,
  size = "default",
  fullWidth,
  className = "",
  children,
  ...props
}: ButtonProps) {
  const variantClass =
    variant === "filled" && accent
      ? accentFilled[accent]
      : variants[variant][surface];

  return (
    <button
      className={`${base} ${sizeClasses[size]} ${variantClass} ${fullWidth ? "w-full" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
