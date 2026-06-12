import { useState, useEffect } from "react";
import { AlertOctagon, X } from "lucide-react";

interface ErrorBannerProps {
  error: string | null;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Auto-reset dismissal when a newly unique error happens
  useEffect(() => {
    if (error && error !== dismissedError) {
      setDismissedError(null);
    }
  }, [error, dismissedError]);

  if (!error || error === dismissedError) return null;

  return (
    <div className="absolute top-0 left-0 right-0 z-40
                    px-4 py-2.5 bg-scout-error-muted/90 backdrop-blur-sm
                    border-b border-scout-error/20 flex items-start gap-2.5">
      <AlertOctagon size={16} className="text-scout-error flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-scout-text-primary text-sm leading-relaxed">{error}</p>
      </div>
      <button
        onClick={() => setDismissedError(error)}
        className="p-0.5 rounded hover:bg-scout-error/20 transition-colors flex-shrink-0"
        aria-label="Dismiss error"
      >
        <X size={14} className="text-scout-error/80" />
      </button>
    </div>
  );
}
