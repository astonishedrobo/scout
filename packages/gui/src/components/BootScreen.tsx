import { useEffect, useState } from "react";
import { PixelPet } from "./PixelPet";

/** How long to wait before admitting this is taking a moment. Short boots
 *  should never flash a caption on their way past. */
const CAPTION_DELAY_MS = 600;

/** Blank theme-aware screen for every in-between state (server connecting,
 * auth unknown, session restoring). Just the pet, front and center. */
export function BootScreen() {
  const [showCaption, setShowCaption] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowCaption(true), CAPTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-scout-canvas">
      <PixelPet working inline size={76} hopEveryMs={2400} />
      {/* Reserve the row so the caption appearing does not shift the pet. */}
      <p
        className={`h-4 text-caption text-scout-muted transition-opacity duration-base ${
          showCaption ? "opacity-100" : "opacity-0"
        }`}
        aria-live="polite"
      >
        {showCaption ? "Connecting…" : ""}
      </p>
    </div>
  );
}
