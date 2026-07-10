import { useState } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

const fieldBase =
  "w-full px-4 py-3 bg-scout-input-bg text-sm text-scout-text placeholder:text-scout-muted focus:outline-none transition-colors";

const fieldCanvas = `${fieldBase} border border-scout-hairline-faint rounded-2xl focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20`;

// Always-black void surface — no theme tokens from fieldBase (light-mode input-bg is cream).
const fieldVoid =
  "w-full px-4 py-3 text-sm text-white placeholder:text-white/40 bg-scout-charcoal focus:outline-none transition-colors border border-white/10 rounded-2xl focus:border-white/30 focus:ring-1 focus:ring-white/20";

// Warm glass for the sunset login: near-transparent amber-tinted field with a
// golden border that glows on focus. Fixed colors — sits on artwork, not theme.
const fieldWarm =
  "w-full px-4 py-3 text-sm text-white placeholder:text-[#f5e3c2]/45 bg-[#3c2614]/35 focus:outline-none transition-all border border-[#ffd6a0]/25 rounded-2xl focus:border-[#ffc46e]/60 focus:ring-1 focus:ring-[#ffc46e]/35";

// Duolingo-style fields for the pixel-city login: bold text, thin visible
// border, tinted to blend with the night sky / day sky respectively.
const fieldPixelNight =
  "w-full px-4 py-3 text-[15px] font-semibold text-white placeholder:font-semibold placeholder:text-white/50 bg-[#241f38]/80 border border-[#b29cf7]/25 rounded-2xl focus:outline-none focus:border-[#b29cf7]/60 focus:ring-1 focus:ring-[#b29cf7]/30 transition-all";
const fieldPixelDay =
  "w-full px-4 py-3 text-[15px] font-semibold text-[#1d2430] placeholder:font-semibold placeholder:text-[#3a4358]/55 bg-white/70 border border-[#5a6f8e]/35 rounded-2xl focus:outline-none focus:border-[#4fa3e0]/75 focus:ring-1 focus:ring-[#4fa3e0]/35 transition-all";

export type InputSurface = "canvas" | "void" | "warm" | "pixel-night" | "pixel-day";

function fieldClassFor(surface: InputSurface) {
  if (surface === "void") return fieldVoid;
  if (surface === "warm") return fieldWarm;
  if (surface === "pixel-night") return fieldPixelNight;
  if (surface === "pixel-day") return fieldPixelDay;
  return fieldCanvas;
}

export function Input({
  className = "",
  surface = "canvas",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { surface?: InputSurface }) {
  return (
    <input
      className={`${fieldClassFor(surface)} ${className}`}
      {...props}
    />
  );
}

export function Textarea({
  className = "",
  surface = "canvas",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { surface?: InputSurface }) {
  return (
    <textarea
      className={`${fieldClassFor(surface)} resize-none ${className}`}
      {...props}
    />
  );
}

export function Label({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-sm font-medium mb-1.5 ${className}`}>
      {children}
    </label>
  );
}

export function PasswordInput({
  className = "",
  surface = "canvas",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { surface?: InputSurface }) {
  const [visible, setVisible] = useState(false);
  const fieldClass = fieldClassFor(surface);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        className={`${fieldClass} pr-11 ${className}`}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-btn transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
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
