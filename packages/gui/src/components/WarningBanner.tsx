import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

interface WarningBannerProps {
  warnings: string[];
}

export function WarningBanner({ warnings }: WarningBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || warnings.length === 0) return null;

  return (
    <div className="shrink-0 px-4 py-2.5 bg-scout-warning-muted border-b border-scout-warning/20 flex items-start gap-2.5">
      <AlertTriangle size={16} className="text-scout-warning shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        {warnings.map((msg, i) => (
          <p key={i} className="text-scout-text text-sm leading-relaxed">{msg}</p>
        ))}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="p-0.5 rounded-btn hover:bg-scout-warning/20 transition-colors shrink-0"
        aria-label="Dismiss warning"
      >
        <X size={14} className="text-scout-warning" />
      </button>
    </div>
  );
}
