import { PixelPet } from "./PixelPet";

/** Blank theme-aware screen for every in-between state (server connecting,
 * auth unknown, session restoring). Just the pet, front and center. */
export function BootScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-scout-canvas">
      <PixelPet working inline size={76} hopEveryMs={2400} />
    </div>
  );
}
