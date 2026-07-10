// Minecraft-flavored pixel art. Characters use a FIXED vivid palette (theme
// tokens desaturate in dark/soft modes and turn sprites gray); small object
// icons keep theme tokens. All crispEdges SVG — no images, no runtime cost.

const SPRITE = {
  skin: "#f2a76b",
  hair: "#f5c542",
  shirt: "#8f78ef",
  pants: "var(--sprite-pants)",
  shoes: "var(--sprite-shoes)",
  dark: "#17181c",
};

export function PixelChest({ size = 42 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 12) / 14} viewBox="0 0 14 12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="0" y="0" width="14" height="12" fill="rgb(var(--scout-void))" />
      <rect x="1" y="1" width="12" height="4" fill="#f0a058" />
      <rect x="1" y="6" width="12" height="5" fill="#f0a058" fillOpacity="0.62" />
      <rect x="1" y="5" width="12" height="1" fill="rgb(var(--scout-void))" />
      <rect x="6" y="4" width="2" height="3" fill="#f5c542" />
      {/* top highlight */}
      <rect x="1" y="1" width="12" height="1" fill="white" fillOpacity="0.22" />
    </svg>
  );
}

export function PixelBook({ size = 42 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#a78bfa" />
      <rect x="1" y="1" width="2" height="10" fill="#a78bfa" style={{ filter: "brightness(0.7)" }} />
      <rect x="3" y="9" width="7" height="1" fill="white" fillOpacity="0.85" />
      <rect x="5" y="4" width="4" height="1" fill="white" fillOpacity="0.4" />
      <rect x="5" y="6" width="3" height="1" fill="white" fillOpacity="0.4" />
      {/* enchantment sparkles */}
      <rect x="0" y="0" width="1" height="1" fill="#f5c542" />
      <rect x="11" y="3" width="1" height="1" fill="#f5c542" />
      <rect x="10" y="0" width="1" height="1" fill="#f0a058" />
    </svg>
  );
}

export function PixelMap({ size = 42 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#f0a058" fillOpacity="0.35" />
      <rect x="1" y="1" width="10" height="1" fill="#f0a058" fillOpacity="0.6" />
      <rect x="1" y="10" width="10" height="1" fill="#f0a058" fillOpacity="0.6" />
      {/* dotted path */}
      <rect x="3" y="8" width="1" height="1" fill="#a78bfa" />
      <rect x="5" y="7" width="1" height="1" fill="#a78bfa" />
      <rect x="6" y="5" width="1" height="1" fill="#a78bfa" />
      {/* X marks the spot */}
      <rect x="8" y="3" width="1" height="1" fill="#e05a5a" />
      <rect x="9" y="4" width="1" height="1" fill="#e05a5a" />
      <rect x="9" y="2" width="1" height="1" fill="#e05a5a" />
      <rect x="7" y="4" width="1" height="1" fill="#e05a5a" />
      <rect x="7" y="2" width="1" height="1" fill="#e05a5a" />
    </svg>
  );
}

// Dazed pixel fellow for unrenderable files: X X eyes, stars orbiting the head.
export function PixelDazed({ size = 72 }: { size?: number }) {
  return (
    // Box is taller than the sprite so the halo has reserved space above the
    // head instead of bleeding over it or the surrounding layout.
    <div className="relative inline-block" style={{ width: size, height: size * 1.4 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        shapeRendering="crispEdges"
        aria-hidden="true"
        className="absolute bottom-0 left-0"
      >
        {/* head */}
        <rect x="8" y="2" width="16" height="14" fill={SPRITE.skin} />
        <rect x="8" y="2" width="16" height="2" fill={SPRITE.hair} />
        {/* X X eyes — 5×5 each so they read clearly */}
        <g fill={SPRITE.dark}>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <rect x={10 + i} y={6 + i} width="1" height="1" />
              <rect x={14 - i} y={6 + i} width="1" height="1" />
              <rect x={17 + i} y={6 + i} width="1" height="1" />
              <rect x={21 - i} y={6 + i} width="1" height="1" />
            </g>
          ))}
        </g>
        {/* wobbly mouth */}
        <rect x="12" y="14" width="1" height="1" fill={SPRITE.dark} />
        <rect x="13" y="13" width="2" height="1" fill={SPRITE.dark} />
        <rect x="15" y="14" width="2" height="1" fill={SPRITE.dark} />
        <rect x="17" y="13" width="2" height="1" fill={SPRITE.dark} />
        <rect x="19" y="14" width="1" height="1" fill={SPRITE.dark} />
        {/* body */}
        <rect x="10" y="16" width="12" height="9" fill={SPRITE.shirt} />
        {/* splayed arms — same height on both sides */}
        <rect x="5" y="17" width="5" height="3" fill={SPRITE.skin} />
        <rect x="22" y="17" width="5" height="3" fill={SPRITE.skin} />
        {/* legs + feet */}
        <rect x="11" y="25" width="4" height="5" fill={SPRITE.pants} />
        <rect x="17" y="25" width="4" height="5" fill={SPRITE.pants} />
        <rect x="10" y="29" width="5" height="2" fill={SPRITE.shoes} />
        <rect x="17" y="29" width="5" height="2" fill={SPRITE.shoes} />
      </svg>
      {/* Halo of stars above the head: a spinning ring flattened into a
          horizontal ellipse (scaleY), so the orbit reads as circling the head. */}
      <div
        className="pointer-events-none absolute left-1/2"
        style={{
          // Visual halo band = center ± height*0.15 after scaleY(0.3); this
          // keeps its lowest point clear of the head (which starts at 0.525H).
          top: -size * 0.2,
          width: size * 0.95,
          height: size * 0.95,
          transform: "translateX(-50%) scaleY(0.3)",
        }}
      >
        <div className="dazed-orbit relative h-full w-full">
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2"
            style={{ fontSize: size * 0.2, lineHeight: 1, color: SPRITE.hair }}
          >
            ★
          </span>
          <span
            className="absolute right-0 top-1/2 -translate-y-1/2"
            style={{ fontSize: size * 0.16, lineHeight: 1, color: SPRITE.hair }}
          >
            ★
          </span>
          <span
            className="absolute left-1/2 top-0 -translate-x-1/2"
            style={{ fontSize: size * 0.14, lineHeight: 1, color: SPRITE.hair }}
          >
            ★
          </span>
        </div>
      </div>
    </div>
  );
}

// Redstone lamp: lit amber block when on, dark stone when off.
export function PixelLamp({ on, size = 12 }: { on: boolean; size?: number }) {
  const core = on ? "#f2c14e" : "rgb(var(--scout-muted))";
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="0" y="0" width="8" height="8" fill={core} fillOpacity={on ? 0.35 : 0.2} />
      <rect x="1" y="1" width="6" height="6" fill={core} fillOpacity={on ? 1 : 0.45} />
      {on && <rect x="2" y="2" width="2" height="2" fill="white" fillOpacity="0.55" />}
      {/* corner studs */}
      <rect x="0" y="0" width="1" height="1" fill="rgb(var(--scout-void))" />
      <rect x="7" y="0" width="1" height="1" fill="rgb(var(--scout-void))" />
      <rect x="0" y="7" width="1" height="1" fill="rgb(var(--scout-void))" />
      <rect x="7" y="7" width="1" height="1" fill="rgb(var(--scout-void))" />
    </svg>
  );
}
