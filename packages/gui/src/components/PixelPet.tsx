import { useEffect, useRef, useState } from "react";

// Scout's pixel pet. Lives on the strip above the composer.
//  - Idle: sits in the right corner, breathing; click it and it waves.
//  - While the agent works: occasional goofy hops.
//  - Long-running work: every ~20s it strolls across the bar and back,
//    waving along the way, then settles back into its corner.
// All movement is CSS animation; React only switches modes.

const STROLL_MS = 11_000;
const STROLL_EVERY_MS = 20_000;
const WAVE_MS = 2_200;

// Fixed sprite palette — vivid on light AND dark backgrounds. Theme tokens
// desaturate in dark/soft modes, which turned the pet into a gray ghost.
const SKIN = "#f2a76b";
const HAIR = "#f5c542";
const SHIRT = "#8f78ef";
const PANTS = "var(--sprite-pants)";
const SHOES = "var(--sprite-shoes)";
const DARK = "#17181c";

function PetSprite({ waving, size = 34, cap = false }: { waving: boolean; size?: number; cap?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="block overflow-visible"
    >
      {/* head */}
      <rect x="6" y="1" width="12" height="10" fill={SKIN} />
      <rect x="6" y="1" width="12" height="2" fill={HAIR} />
      {/* red cap: crown over the hair + a brim pointing forward */}
      {cap && (
        <>
          <rect x="5" y="0" width="14" height="3" fill="#d93b3b" />
          <rect x="16" y="3" width="6" height="1" fill="#d93b3b" />
          <rect x="11" y="0" width="2" height="1" fill="#a82a2a" />
        </>
      )}
      {/* eyes */}
      <rect x="8" y="5" width="2" height="2" fill={DARK} />
      <rect x="14" y="5" width="2" height="2" fill={DARK} />
      {/* smile */}
      <rect x="9" y="8" width="1" height="1" fill={DARK} />
      <rect x="10" y="9" width="4" height="1" fill={DARK} />
      <rect x="14" y="8" width="1" height="1" fill={DARK} />
      {/* body */}
      <rect x="8" y="11" width="8" height="7" fill={SHIRT} />
      {/* arms resting at the sides */}
      {!waving && (
        <>
          <rect x="5" y="11" width="3" height="5" fill={SKIN} />
          <rect x="16" y="11" width="3" height="5" fill={SKIN} />
        </>
      )}
      {/* excited: both arms extended out, flapping like it's trying to fly */}
      {waving && (
        <>
          <g className="pet-flap-left">
            <rect x="2" y="11" width="6" height="3" fill={SKIN} />
          </g>
          <g className="pet-flap-right">
            <rect x="16" y="11" width="6" height="3" fill={SKIN} />
          </g>
        </>
      )}
      {/* legs + feet */}
      <rect x="9" y="18" width="2" height="4" fill={PANTS} />
      <rect x="13" y="18" width="2" height="4" fill={PANTS} />
      <rect x="8" y="21" width="3" height="2" fill={SHOES} />
      <rect x="13" y="21" width="3" height="2" fill={SHOES} />
    </svg>
  );
}

export function PixelPet({
  working,
  size = 34,
  idleStrollEveryMs,
  inline = false,
  hopEveryMs,
  cap = false,
}: {
  working: boolean;
  /** Sprite size in px — the home screen uses a bigger fellow. */
  size?: number;
  /** Also stroll while idle, at this interval (home screen). */
  idleStrollEveryMs?: number;
  /** Render in normal flow instead of pinned to the container edge. */
  inline?: boolean;
  /** Do a spontaneous flap-hop burst on load and at this interval (login). */
  hopEveryMs?: number;
  /** Red cap for sunny days. */
  cap?: boolean;
}) {
  const [waving, setWaving] = useState(false);
  const [strolling, setStrolling] = useState(false);
  const waveTimer = useRef<number>();
  const strollEnd = useRef<number>();

  const waveNow = () => {
    window.clearTimeout(waveTimer.current);
    setWaving(true);
    waveTimer.current = window.setTimeout(() => setWaving(false), WAVE_MS);
  };

  const strollEvery = working ? STROLL_EVERY_MS : idleStrollEveryMs;

  useEffect(() => {
    if (!strollEvery) {
      setStrolling(false);
      return;
    }
    const interval = window.setInterval(() => {
      setStrolling(true);
      setWaving(true);
      window.clearTimeout(strollEnd.current);
      strollEnd.current = window.setTimeout(() => {
        setStrolling(false);
        setWaving(false);
      }, STROLL_MS);
    }, strollEvery);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(strollEnd.current);
      setStrolling(false);
    };
  }, [strollEvery]);

  // Spontaneous excitement: one burst shortly after load, then on a timer.
  useEffect(() => {
    if (!hopEveryMs) return;
    const burst = () => {
      setWaving(true);
      window.clearTimeout(waveTimer.current);
      waveTimer.current = window.setTimeout(() => setWaving(false), 1400);
    };
    const first = window.setTimeout(burst, 700);
    const interval = window.setInterval(burst, hopEveryMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [hopEveryMs]);

  useEffect(() => () => {
    window.clearTimeout(waveTimer.current);
    window.clearTimeout(strollEnd.current);
  }, []);

  return (
    <button
      type="button"
      onClick={waveNow}
      title={working ? "Scout is working on it!" : "Hi!"}
      aria-label="Scout's pet"
      className={`pet cursor-pointer border-0 bg-transparent p-0 ${
        inline ? "relative inline-block" : "absolute bottom-0"
      } ${strolling ? "pet-stroll" : waving ? "pet-hop" : working ? "pet-goof" : "pet-breathe"}`}
      style={inline ? undefined : { right: 10 }}
    >
      <PetSprite waving={waving} size={size} cap={cap} />
    </button>
  );
}
