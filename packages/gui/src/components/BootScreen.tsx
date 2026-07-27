import { useEffect, useState } from "react";
import { PixelPet } from "./PixelPet";

/** How long to wait before admitting this is taking a moment. Short boots
 *  should never flash a caption on their way past. */
const CAPTION_DELAY_MS = 600;

/** Past this, "Connecting…" stops being informative and starts looking hung. */
const STALLED_MS = 10_000;

/** Blank theme-aware screen for every in-between state (server connecting,
 * auth unknown, session restoring). Just the pet, front and center. */
export function BootScreen() {
  const [showCaption, setShowCaption] = useState(false);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const caption = window.setTimeout(() => setShowCaption(true), CAPTION_DELAY_MS);
    const stall = window.setTimeout(() => setStalled(true), STALLED_MS);
    return () => {
      window.clearTimeout(caption);
      window.clearTimeout(stall);
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-scout-canvas">
      <PixelPet working inline size={76} hopEveryMs={2400} />
      {/* Reserve the row so the caption appearing does not shift the pet. */}
      <p
        className={`h-4 text-caption text-scout-muted transition-opacity duration-base ${
          showCaption ? "opacity-100" : "opacity-0"
        }`}
        aria-live="polite"
      >
        {stalled ? "Still connecting…" : showCaption ? "Connecting…" : ""}
      </p>
      {/* After ten seconds this is no longer a slow boot, it is probably stuck. */}
      {stalled && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-caption font-semibold text-scout-text underline underline-offset-2 transition-opacity hover:opacity-80"
        >
          Reload
        </button>
      )}
    </div>
  );
}
