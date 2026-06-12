import { useState } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

const fieldBase =
  "w-full px-4 py-3 bg-scout-input-bg text-sm text-scout-text placeholder:text-scout-muted focus:outline-none transition-colors";

const fieldCanvas = `${fieldBase} border border-scout-hairline-faint rounded-2xl focus:border-scout-text/30 focus:ring-1 focus:ring-scout-text/20`;

// Always-black void surface — no theme tokens from fieldBase (light-mode input-bg is cream).
const fieldVoid =
  "w-full px-4 py-3 text-sm text-white placeholder:text-white/40 bg-scout-charcoal focus:outline-none transition-colors border border-white/10 rounded-2xl focus:border-white/30 focus:ring-1 focus:ring-white/20";

export function Input({
  className = "",
  surface = "canvas",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { surface?: "canvas" | "void" }) {
  return (
    <input
      className={`${surface === "void" ? fieldVoid : fieldCanvas} ${className}`}
      {...props}
    />
  );
}

export function Textarea({
  className = "",
  surface = "canvas",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { surface?: "canvas" | "void" }) {
  return (
    <textarea
      className={`${surface === "void" ? fieldVoid : fieldCanvas} resize-none ${className}`}
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
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { surface?: "canvas" | "void" }) {
  const [visible, setVisible] = useState(false);
  const fieldClass = surface === "void" ? fieldVoid : fieldCanvas;

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
          surface === "void"
            ? "text-white/40 hover:text-white/70"
            : "text-scout-muted hover:text-scout-text"
        }`}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
