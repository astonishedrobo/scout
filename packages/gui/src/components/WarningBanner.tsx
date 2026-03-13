import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

interface WarningBannerProps {
  warnings: string[];
}

export function WarningBanner({ warnings }: WarningBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || warnings.length === 0) return null;

  return (
    <div className="absolute top-0 left-0 right-0 z-40
                    px-4 py-2.5 bg-amber-950/90 backdrop-blur-sm
                    border-b border-amber-700/30 flex items-start gap-2.5">
      <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        {warnings.map((msg, i) => (
          <p key={i} className="text-amber-200/90 text-sm leading-relaxed">{msg}</p>
        ))}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="p-0.5 rounded hover:bg-amber-800/40 transition-colors flex-shrink-0"
        aria-label="Dismiss warning"
      >
        <X size={14} className="text-amber-400/70" />
      </button>
    </div>
  );
}
