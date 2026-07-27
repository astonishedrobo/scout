import { useId, useState } from "react";
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * Sizes exist because the primitive was login-shaped (`px-4 py-3 text-label`) and
 * dense panels need something smaller — which is why 21 raw `<input>`s and 9
 * raw `<textarea>`s hand-rolled their own instead of using this.
 */
export type InputSize = "lg" | "md" | "sm";

const sizeClass: Record<InputSize, string> = {
  lg: "px-3.5 py-2.5 text-label",
  md: "px-3 py-2 text-label",
  sm: "px-2 py-1.5 text-caption",
};

const fieldBase =
  "w-full bg-scout-input-bg text-scout-text placeholder:text-scout-muted focus:outline-none transition-colors";

// rounded-card, not a fixed radius: the theme tightens radii in `soft`, and a
// hardcoded rounded-card froze every field at one theme's value.
const fieldCanvas = `${fieldBase} border border-scout-hairline-faint rounded-btn focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20`;

// Always-black void surface — no theme tokens from fieldBase (light-mode input-bg is cream).
const fieldVoid =
  "w-full text-white placeholder:text-white/40 bg-scout-charcoal focus:outline-none transition-colors border border-white/10 rounded-card focus:border-white/30 focus:ring-1 focus:ring-white/20";

// Warm glass for the sunset login: near-transparent amber-tinted field with a
// golden border that glows on focus. Fixed colors — sits on artwork, not theme.
const fieldWarm =
  "w-full text-white placeholder:text-[#f5e3c2]/45 bg-[#3c2614]/35 focus:outline-none transition-all border border-[#ffd6a0]/25 rounded-card focus:border-[#ffc46e]/60 focus:ring-1 focus:ring-[#ffc46e]/35";

// Duolingo-style fields for the pixel-city login: bold text, thin visible
// border, tinted to blend with the night sky / day sky respectively.
const fieldPixelNight =
  "w-full font-semibold text-white placeholder:font-semibold placeholder:text-white/50 bg-[#241f38]/80 border border-[#b29cf7]/25 rounded-card focus:outline-none focus:border-[#b29cf7]/60 focus:ring-1 focus:ring-[#b29cf7]/30 transition-all";
const fieldPixelDay =
  "w-full font-semibold text-[#1d2430] placeholder:font-semibold placeholder:text-[#3a4358]/55 bg-white/70 border border-[#5a6f8e]/35 rounded-card focus:outline-none focus:border-[#4fa3e0]/75 focus:ring-1 focus:ring-[#4fa3e0]/35 transition-all";

export type InputSurface = "canvas" | "void" | "warm" | "pixel-night" | "pixel-day";

function fieldClassFor(surface: InputSurface, size: InputSize, invalid = false) {
  const base =
    surface === "void"
      ? fieldVoid
      : surface === "warm"
        ? fieldWarm
        : surface === "pixel-night"
          ? fieldPixelNight
          : surface === "pixel-day"
            ? fieldPixelDay
            : fieldCanvas;
  // The pixel surfaces set their own type size deliberately (bold 15px).
  const sizing = surface.startsWith("pixel") ? `${sizeClass[size].replace(/text-\S+/, "")} text-prose` : sizeClass[size];
  return `${base} ${sizing} ${invalid ? "border-scout-error/60 focus:border-scout-error" : ""}`;
}

type FieldExtras = { surface?: InputSurface; size?: InputSize; invalid?: boolean };

export function Input({
  className = "",
  surface = "canvas",
  size = "lg",
  invalid,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldExtras) {
  return (
    <input
      className={`${fieldClassFor(surface, size, invalid)} ${className}`}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}

export function Textarea({
  className = "",
  surface = "canvas",
  size = "lg",
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldExtras) {
  return (
    <textarea
      className={`${fieldClassFor(surface, size, invalid)} resize-none ${className}`}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}

export function Select({
  className = "",
  surface = "canvas",
  size = "lg",
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & FieldExtras) {
  return (
    <select className={`${fieldClassFor(surface, size)} ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Label({
  children,
  className = "",
  htmlFor,
}: {
  children: React.ReactNode;
  className?: string;
  /** Associates the label with its control. Prefer `<Field>`, which wires it. */
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={`block text-label font-medium mb-1.5 ${className}`}>
      {children}
    </label>
  );
}

/**
 * Label + control + optional hint/error, with the `htmlFor`/`id` pair wired.
 *
 * This is the shape that repeats ~21 times across AdminPanel and SettingsPanel
 * as a hand-written `<label><span>…</span><input …/></label>`, with three
 * competing label styles and — because `Label` had no `htmlFor` — no field in
 * the app actually label-associated.
 */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className = "",
  labelClassName = "",
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  /** Pass when the control's id is set by the caller. */
  htmlFor?: string;
  className?: string;
  labelClassName?: string;
  children: React.ReactNode | ((id: { id: string; describedBy?: string }) => React.ReactNode);
}) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const messageId = error || hint ? `${id}-message` : undefined;

  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className={`block text-caption font-medium text-scout-text ${labelClassName}`}>
        {label}
        {required && (
          <span className="ml-1 text-scout-error" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {typeof children === "function" ? children({ id, describedBy: messageId }) : children}
      {(error || hint) && (
        <p
          id={messageId}
          className={`text-micro leading-relaxed ${error ? "text-scout-error" : "text-scout-muted"}`}
          {...(error ? { role: "alert" as const } : {})}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function PasswordInput({
  className = "",
  surface = "canvas",
  size = "lg",
  invalid,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & FieldExtras) {
  const [visible, setVisible] = useState(false);
  const fieldClass = fieldClassFor(surface, size, invalid);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        className={`${fieldClass} pr-12 ${className}`}
        aria-invalid={invalid || undefined}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        // 32px box (was 24px, under the minimum target).
        className={`absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-btn transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
          surface === "pixel-day"
            ? "text-[#3a4358]/60 hover:text-[#1d2430]"
            : surface === "canvas"
              ? "text-scout-muted hover:text-scout-text"
              : "text-white/40 hover:text-white/70"
        }`}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
