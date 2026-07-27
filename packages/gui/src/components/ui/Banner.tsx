import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, Info, X } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * One toned banner. `ErrorBanner` and `WarningBanner` were the same 30-line
 * component with the token stem swapped, and neither had `role="alert"`, so an
 * error was never announced.
 */
export type BannerTone = "error" | "warning" | "info";

const tones: Record<BannerTone, { surface: string; icon: string; Icon: typeof AlertOctagon }> = {
  error: {
    surface: "bg-scout-error-muted border-scout-error/20",
    icon: "text-scout-error",
    Icon: AlertOctagon,
  },
  warning: {
    surface: "bg-scout-warning-muted border-scout-warning/20",
    icon: "text-scout-warning",
    Icon: AlertTriangle,
  },
  info: {
    surface: "bg-scout-lift/60 border-scout-hairline-faint",
    icon: "text-scout-muted",
    Icon: Info,
  },
};

export function Banner({
  tone = "error",
  messages,
  onDismiss,
  action,
  variant = "attached",
  className = "",
}: {
  tone?: BannerTone;
  /** One or more lines. An empty list renders nothing. */
  messages: string[];
  onDismiss?: () => void;
  /** Inline affordance, e.g. an Undo. Sits after the message. */
  action?: React.ReactNode;
  /**
   * `attached` sits flush under a panel header (bottom rule only); `inline`
   * stands alone in a content column and closes its own box.
   */
  variant?: "attached" | "inline";
  className?: string;
}) {
  const { surface, icon, Icon } = tones[tone];
  if (messages.length === 0) return null;

  return (
    <div
      className={`flex shrink-0 items-start gap-2.5 px-4 py-2.5 ${
        variant === "inline" ? "rounded-card border" : "border-b"
      } ${surface} ${className}`}
      // Errors are announced immediately; a warning waits for a pause.
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <Icon size={16} className={`mt-0.5 shrink-0 ${icon}`} />
      <div className="min-w-0 flex-1">
        {messages.map((message, i) => (
          <p key={i} className="text-label leading-relaxed text-scout-text">
            {message}
          </p>
        ))}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <IconButton label={`Dismiss ${tone}`} onClick={onDismiss} showTitle={false} className={icon}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}

/** Self-dismissing error banner bound to a single error string. */
export function ErrorBanner({ error }: { error: string | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Reset only when the error itself changes — resetting on every render that
  // disagreed with the dismissal made a dismissed banner reappear instantly.
  useEffect(() => {
    setDismissed((current) => (current === error ? current : null));
  }, [error]);

  if (!error || error === dismissed) return null;
  return <Banner tone="error" messages={[error]} onDismiss={() => setDismissed(error)} />;
}

/** Self-dismissing warning banner for the server's startup warnings. */
export function WarningBanner({ warnings }: { warnings: string[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return <Banner tone="warning" messages={warnings} onDismiss={() => setDismissed(true)} />;
}
