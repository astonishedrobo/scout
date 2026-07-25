import { BRAND } from "./spritePalette";
// Scout logomark — a chunky pixel-art compass star (a little 8-bit personality
// against the otherwise quiet UI). crispEdges keeps the pixels sharp at any size.
export function ScoutMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* arms */}
      <rect x="5" y="0" width="2" height="3" fill={BRAND.lavender} />
      <rect x="5" y="9" width="2" height="3" fill={BRAND.lavender} />
      <rect x="0" y="5" width="3" height="2" fill={BRAND.peach} />
      <rect x="9" y="5" width="3" height="2" fill={BRAND.peach} />
      {/* body */}
      <rect x="3" y="3" width="6" height="6" fill={BRAND.lavender} fillOpacity="0.45" />
      <rect x="4" y="4" width="4" height="4" fill={BRAND.amber} />
      {/* specular pixel */}
      <rect x="4" y="4" width="1" height="1" fill="white" fillOpacity="0.7" />
    </svg>
  );
}

// Small decorative 4-pixel sparkle for empty states and flourishes.
export function PixelSparkle({ size = 10, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 3 3"
      shapeRendering="crispEdges"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="1" y="0" width="1" height="1" />
      <rect x="0" y="1" width="1" height="1" />
      <rect x="2" y="1" width="1" height="1" />
      <rect x="1" y="2" width="1" height="1" />
    </svg>
  );
}

export function ScoutLockup({ markSize = 24, textClass = "text-[17px]" }: { markSize?: number; textClass?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <ScoutMark size={markSize} />
      <span className={`font-display ${textClass} font-semibold tracking-[-0.035em] text-scout-text`}>
        Scout
      </span>
    </span>
  );
}
