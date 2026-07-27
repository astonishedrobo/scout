import { PlugZap, RefreshCw } from "lucide-react";
import { Button } from "./ui/Button";
import { PixelDazed } from "./PixelArt";

/**
 * Terminal state for "the server isn't there".
 *
 * Every route gate used to be `&& !serverError`, so a failed connection fell
 * through to the full workspace with an empty baseUrl: a live-looking composer,
 * an empty sidebar, empty panels, and the failure reported only by a banner
 * inside otherwise working chrome — with no way to retry.
 */
export function ServerErrorScreen({ error }: { error: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-scout-canvas px-6 text-center">
      <PixelDazed size={44} />
      <div className="max-w-sm space-y-1.5">
        <h1 className="text-body font-semibold text-scout-text">Can't reach the Scout server</h1>
        <p className="text-label leading-relaxed text-scout-muted" role="alert">
          {error}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="filled" surface="canvas" onClick={() => window.location.reload()}>
          <RefreshCw size={15} />
          Try again
        </Button>
      </div>
      <p className="flex items-center gap-1.5 text-caption text-scout-muted/80">
        <PlugZap size={13} />
        Check that the server is running, then reload.
      </p>
    </div>
  );
}
