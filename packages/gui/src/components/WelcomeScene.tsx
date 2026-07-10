import { PixelSparkle } from "./ScoutMark";
import { PixelPet } from "./PixelPet";

// Ambient pixel scenery. All transform/opacity animation — GPU-composited.
//  - WelcomeScene: sky behind the home screen (clouds, stars, birds, the
//    occasional shooting star), tinted from theme tokens.
//  - PixelDuskScene: fuller fixed-palette dusk scene for the login page
//    (mountains, denser sky, the pet patrolling the ground).

function PixelCloud({ size = 64 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 10) / 26}
      viewBox="0 0 26 10"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="7" y="2" width="6" height="2" />
      <rect x="15" y="1" width="5" height="3" />
      <rect x="4" y="4" width="18" height="4" />
      <rect x="2" y="6" width="22" height="2" />
    </svg>
  );
}

function PixelBird({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size / 2}
      viewBox="0 0 10 5"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="0" y="2" width="1" height="1" />
      <rect x="1" y="1" width="1" height="1" />
      <rect x="2" y="0" width="1" height="1" />
      <rect x="3" y="1" width="1" height="1" />
      <rect x="4" y="2" width="2" height="1" />
      <rect x="6" y="1" width="1" height="1" />
      <rect x="7" y="0" width="1" height="1" />
      <rect x="8" y="1" width="1" height="1" />
      <rect x="9" y="2" width="1" height="1" />
    </svg>
  );
}

const CLOUDS = [
  { top: "8%", size: 92, duration: 105, delay: -30, opacity: 0.14 },
  { top: "18%", size: 58, duration: 145, delay: -95, opacity: 0.1 },
  { top: "5%", size: 44, duration: 170, delay: -140, opacity: 0.08 },
  { top: "27%", size: 74, duration: 120, delay: -60, opacity: 0.09 },
  { top: "36%", size: 50, duration: 160, delay: -20, opacity: 0.07 },
  { top: "13%", size: 66, duration: 135, delay: -110, opacity: 0.11 },
  { top: "44%", size: 40, duration: 185, delay: -75, opacity: 0.06 },
  { top: "58%", size: 56, duration: 150, delay: -35, opacity: 0.05 },
];

const STARS = [
  { top: "10%", left: "16%", size: 8, delay: 0 },
  { top: "22%", left: "8%", size: 6, delay: 1.2 },
  { top: "7%", left: "72%", size: 7, delay: 2.1 },
  { top: "18%", left: "88%", size: 6, delay: 0.7 },
  { top: "31%", left: "64%", size: 5, delay: 1.7 },
  { top: "5%", left: "38%", size: 5, delay: 2.6 },
  { top: "26%", left: "30%", size: 6, delay: 3.1 },
  { top: "14%", left: "52%", size: 5, delay: 0.4 },
];

const BIRDS = [
  { top: "16%", size: 13, duration: 48, delay: -12, opacity: 0.4 },
  { top: "24%", size: 10, duration: 62, delay: -40, opacity: 0.3 },
];

export function WelcomeScene() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {CLOUDS.map((cloud, i) => (
        <div
          key={`c${i}`}
          className="cloud-drift absolute text-scout-muted"
          style={{
            top: cloud.top,
            opacity: cloud.opacity,
            animationDuration: `${cloud.duration}s`,
            animationDelay: `${cloud.delay}s`,
          }}
        >
          <PixelCloud size={cloud.size} />
        </div>
      ))}
      {STARS.map((star, i) => (
        <div
          key={`s${i}`}
          className="star-twinkle absolute"
          style={{ top: star.top, left: star.left, color: "#f5c542", animationDelay: `${star.delay}s` }}
        >
          <PixelSparkle size={star.size} />
        </div>
      ))}
      {BIRDS.map((bird, i) => (
        <div
          key={`b${i}`}
          className="cloud-drift absolute text-scout-muted"
          style={{
            top: bird.top,
            opacity: bird.opacity,
            animationDuration: `${bird.duration}s`,
            animationDelay: `${bird.delay}s`,
          }}
        >
          <div className="bird-bob">
            <PixelBird size={bird.size} />
          </div>
        </div>
      ))}
      {/* one shooting star, streaking every ~18s */}
      <div className="shooting-star absolute" style={{ top: "9%", left: "78%", color: "#f5c542" }}>
        <PixelSparkle size={7} />
      </div>
    </div>
  );
}

// ── Login city scene: pixel city with a day/night toggle ─────────

import { useState } from "react";

// Deterministic pseudo-random so the skyline is stable across renders.
function prng(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

type Building = { x: number; w: number; h: number; kind: "highrise" | "apartment" | "shop" | "factory" | "tower" };

// A curated mini-city: bimodal heights (tall high-rises + short shops, a few
// mid apartments), factories bookending the strip, awning shops in between,
// and one TV-tower landmark. Deterministic, edge to edge.
function makeCity(seed: number): Building[] {
  const buildings: Building[] = [];
  let x = -6;
  let i = 0;
  let towerPlaced = false;
  while (x < 400) {
    let kind: Building["kind"];
    if (i === 0 || x > 356) kind = "factory";
    // Keep the landmark clear of the centered login card (~viewBox 150–250).
    else if (!towerPlaced && x > 262) {
      kind = "tower";
      towerPlaced = true;
    } else {
      const roll = prng(seed + i * 17);
      kind = roll < 0.38 ? "highrise" : roll < 0.72 ? "shop" : "apartment";
    }
    let w: number, h: number;
    if (kind === "factory") {
      w = 34 + Math.floor(prng(seed * 3 + i) * 10);
      h = 20 + Math.floor(prng(seed * 5 + i) * 6);
    } else if (kind === "tower") {
      w = 30;
      h = 97;
    } else if (kind === "highrise") {
      w = 22 + Math.floor(prng(seed * 3 + i) * 8);
      h = 58 + Math.floor(prng(seed * 5 + i) * 32);
    } else if (kind === "apartment") {
      w = 26 + Math.floor(prng(seed * 3 + i) * 10);
      h = 34 + Math.floor(prng(seed * 5 + i) * 14);
    } else {
      w = 17 + Math.floor(prng(seed * 3 + i) * 8);
      h = 15 + Math.floor(prng(seed * 5 + i) * 8);
    }
    buildings.push({ x, w, h, kind });
    x += w + 1 + Math.floor(prng(seed * 7 + i * 11) * 4);
    i += 1;
  }
  return buildings;
}

const CITY_BUILDINGS = makeCity(7);

const AWNING_COLORS = ["#e05a8a", "#4fc4b0", "#f2c14e", "#4fa3e0"];

const CITY = {
  night: {
    front: "#282344",
    alt: "#2f2950",
    windowLit: "#f2c14e",
    windowDark: "#141126",
    smoke: "#8a8a99",
  },
  day: {
    front: "#b9bdc6",
    alt: "#aab0bc",
    windowLit: "#7fb2d9",
    windowDark: "#8fbede",
    smoke: "#c9ccd4",
  },
};

function windowGrid(b: Building, i: number, day: boolean, c: (typeof CITY)["night"]) {
  const windows = [];
  const cols = Math.max(1, Math.floor((b.w - 6) / 6));
  const rows = Math.max(1, Math.floor((b.h - 8) / 8));
  for (let col = 0; col < cols; col++) {
    for (let r = 0; r < rows; r++) {
      const lit = day || prng(i * 97 + col * 13 + r * 29) < 0.34;
      windows.push(
        <rect
          key={`w${col}-${r}`}
          x={b.x + 4 + col * 6}
          y={100 - b.h + 5 + r * 8}
          width={3}
          height={4}
          fill={lit ? c.windowLit : c.windowDark}
          fillOpacity={day ? 0.65 + prng(i + col + r) * 0.35 : lit ? 0.55 + prng(i + col + r) * 0.45 : 1}
        />,
      );
    }
  }
  return windows;
}

function CityBuilding({ b, i, day }: { b: Building; i: number; day: boolean }) {
  const c = day ? CITY.day : CITY.night;
  const body = prng(i * 31) < 0.5 ? c.front : c.alt;

  if (b.kind === "tower") {
    // Fernsehturm-style: pole, observation sphere with a lit window band, antenna.
    const cx = b.x + b.w / 2;
    return (
      <g>
        <rect x={cx - 2} y={30} width={4} height={70} fill={body} />
        <rect x={cx - 5} y={94} width={10} height={6} fill={body} />
        <rect x={cx - 6} y={16} width={12} height={10} fill={body} />
        <rect x={cx - 4} y={14} width={8} height={14} fill={body} />
        <rect x={cx - 5} y={19} width={10} height={2} fill={day ? c.windowLit : "#f2c14e"} fillOpacity={0.85} />
        <rect x={cx - 1} y={4} width={2} height={10} fill={body} />
        <rect x={cx - 1} y={3} width={2} height={2} fill="#e05a5a" />
      </g>
    );
  }

  if (b.kind === "factory") {
    // Wide low hall, sawtooth roof, chimney with smoke.
    const teeth = [];
    const toothW = 8;
    for (let t = 0; t * toothW < b.w - 6; t++) {
      teeth.push(
        <rect key={`t${t}`} x={b.x + t * toothW} y={100 - b.h - 5} width={toothW / 2} height={5} fill={body} />,
      );
    }
    return (
      <g>
        <rect x={b.x} y={100 - b.h} width={b.w} height={b.h} fill={body} />
        {teeth}
        <rect x={b.x + b.w - 8} y={100 - b.h - 14} width={4} height={14} fill={body} />
        <rect x={b.x + b.w - 8} y={100 - b.h - 17} width={2} height={2} fill={c.smoke} fillOpacity={0.5} />
        <rect x={b.x + b.w - 5} y={100 - b.h - 20} width={2} height={2} fill={c.smoke} fillOpacity={0.3} />
        {windowGrid({ ...b, h: b.h - 2 }, i, day, c)}
      </g>
    );
  }

  if (b.kind === "shop") {
    // Storefront with a striped awning and a little banner sign on the roof.
    const accent = AWNING_COLORS[i % AWNING_COLORS.length];
    const stripes = [];
    for (let sx = 0; sx * 4 < b.w; sx++) {
      stripes.push(
        <rect
          key={`a${sx}`}
          x={b.x + sx * 4}
          y={100 - b.h + 3}
          width={Math.min(4, b.w - sx * 4)}
          height={4}
          fill={sx % 2 === 0 ? accent : "#e8e4da"}
        />,
      );
    }
    return (
      <g>
        <rect x={b.x} y={100 - b.h} width={b.w} height={b.h} fill={body} />
        {/* roof banner ("ICE CREAM" energy) */}
        <rect x={b.x + 2} y={100 - b.h - 6} width={b.w - 4} height={5} fill={accent} />
        <rect x={b.x + 4} y={100 - b.h - 4} width={2} height={1} fill="#ffffff" />
        <rect x={b.x + 8} y={100 - b.h - 4} width={3} height={1} fill="#ffffff" />
        <rect x={b.x + 13} y={100 - b.h - 4} width={2} height={1} fill="#ffffff" />
        {stripes}
        {/* door + shop window, warm-lit at night */}
        <rect x={b.x + 3} y={100 - 7} width={4} height={7} fill={c.windowDark} />
        <rect
          x={b.x + 9}
          y={100 - 7}
          width={Math.max(4, b.w - 12)}
          height={5}
          fill={day ? c.windowLit : "#f2c14e"}
          fillOpacity={day ? 0.8 : 0.75}
        />
      </g>
    );
  }

  // High-rise / apartment: plain slab + window grid; antennas on the tall ones.
  return (
    <g>
      <rect x={b.x} y={100 - b.h} width={b.w} height={b.h} fill={body} />
      {b.h > 60 && (
        <rect x={b.x + Math.floor(b.w / 2) - 1} y={100 - b.h - 5} width={2} height={5} fill={body} />
      )}
      {windowGrid(b, i, day, c)}
    </g>
  );
}

function PixelCity({ day }: { day: boolean }) {
  return (
    <svg
      viewBox="0 0 400 100"
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className="absolute inset-x-0 bottom-[16vh] h-[30vh] w-full"
      aria-hidden="true"
    >
      {CITY_BUILDINGS.map((b, i) => (
        <CityBuilding key={i} b={b} i={i} day={day} />
      ))}
    </svg>
  );
}

// A proper little sedan: cabin, windshields, body, bumpers, wheels with hubs.
function PixelCar({ color, size = 64 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size / 2}
      viewBox="0 0 26 13"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="7" y="1" width="11" height="4" fill={color} style={{ filter: "brightness(1.2)" }} />
      <rect x="8" y="2" width="4" height="3" fill="#bcd9f0" fillOpacity="0.85" />
      <rect x="13" y="2" width="4" height="3" fill="#bcd9f0" fillOpacity="0.85" />
      <rect x="1" y="5" width="24" height="4" fill={color} />
      <rect x="2" y="9" width="22" height="1" fill="#000000" fillOpacity="0.25" />
      <rect x="24" y="6" width="2" height="2" fill="#ffe9a8" />
      <rect x="0" y="6" width="1" height="2" fill="#c94040" />
      <rect x="4" y="9" width="4" height="4" fill="#101018" />
      <rect x="18" y="9" width="4" height="4" fill="#101018" />
      <rect x="5" y="10" width="2" height="2" fill="#4a4a55" />
      <rect x="19" y="10" width="2" height="2" fill="#4a4a55" />
    </svg>
  );
}

// Two lanes: near lane drives right (bigger), far lane drives left (smaller).
const CARS = [
  { color: "#e05a5a", duration: 15, delay: -3, bottom: "7.6vh", size: 62, reverse: false },
  { color: "#f2c14e", duration: 21, delay: -12, bottom: "7.6vh", size: 62, reverse: false },
  { color: "#4fa3e0", duration: 18, delay: -7, bottom: "12vh", size: 52, reverse: true },
  { color: "#7bc47f", duration: 24, delay: -18, bottom: "12vh", size: 52, reverse: true },
];

const LAMP_POSITIONS = ["6%", "26%", "46%", "66%", "86%"];

function StreetLamp({ day }: { day: boolean }) {
  return (
    <div className="relative">
      <svg width="26" height="88" viewBox="0 0 13 44" shapeRendering="crispEdges" aria-hidden="true">
        <rect x="5" y="6" width="2" height="38" fill={day ? "#6a6e78" : "#2c2838"} />
        <rect x="5" y="4" width="7" height="2" fill={day ? "#6a6e78" : "#2c2838"} />
        <rect x="9" y="6" width="3" height="3" fill={day ? "#9ba0ab" : "#f2c14e"} />
      </svg>
      {!day && (
        <div
          className="absolute"
          style={{
            right: -4,
            top: 6,
            width: 22,
            height: 22,
            background: "radial-gradient(circle, rgba(242,193,78,0.35), transparent 70%)",
          }}
        />
      )}
    </div>
  );
}

function PixelSun() {
  return (
    <svg width="48" height="48" viewBox="0 0 13 13" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="4" y="3" width="5" height="7" fill="#f5c542" />
      <rect x="3" y="4" width="7" height="5" fill="#f5c542" />
      <rect x="5" y="4" width="2" height="2" fill="#ffe9a8" />
      <rect x="6" y="0" width="1" height="2" fill="#f5c542" />
      <rect x="6" y="11" width="1" height="2" fill="#f5c542" />
      <rect x="0" y="6" width="2" height="1" fill="#f5c542" />
      <rect x="11" y="6" width="2" height="1" fill="#f5c542" />
      <rect x="1" y="1" width="1" height="1" fill="#f5c542" />
      <rect x="11" y="1" width="1" height="1" fill="#f5c542" />
      <rect x="1" y="11" width="1" height="1" fill="#f5c542" />
      <rect x="11" y="11" width="1" height="1" fill="#f5c542" />
    </svg>
  );
}

function PixelMoon() {
  return (
    <svg width="44" height="44" viewBox="0 0 11 11" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="2" y="1" width="7" height="9" fill="#f0e6c8" fillOpacity="0.9" />
      <rect x="1" y="2" width="9" height="7" fill="#f0e6c8" fillOpacity="0.9" />
      <rect x="3" y="3" width="2" height="2" fill="#d8cba4" />
      <rect x="6" y="6" width="2" height="1" fill="#d8cba4" />
    </svg>
  );
}

const DUSK_STARS = STARS.concat([
  { top: "40%", left: "20%", size: 6, delay: 1.9 },
  { top: "36%", left: "80%", size: 7, delay: 2.9 },
  { top: "48%", left: "44%", size: 5, delay: 0.9 },
  { top: "12%", left: "60%", size: 8, delay: 3.6 },
  { top: "44%", left: "92%", size: 5, delay: 1.4 },
  { top: "52%", left: "10%", size: 5, delay: 2.4 },
]);

export function PixelDuskScene({
  roadText,
  day: dayProp,
  onToggleDay,
}: {
  roadText?: string;
  /** Controlled day/night (login form recolors with the scene). */
  day?: boolean;
  onToggleDay?: () => void;
}) {
  const [internalDay, setInternalDay] = useState(false);
  const day = dayProp ?? internalDay;
  const toggleDay = onToggleDay ?? (() => setInternalDay((d) => !d));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* sky */}
      <div
        className="absolute inset-0 transition-colors duration-700"
        style={{
          background: day
            ? "linear-gradient(180deg, #8fc3ec 0%, #b8daf2 55%, #f4e9d4 100%)"
            : "linear-gradient(180deg, #131218 0%, #1b1826 48%, #262038 78%, #201b2e 100%)",
        }}
      />
      {/* moon / sun — click to flip day and night */}
      <button
        type="button"
        onClick={toggleDay}
        title={day ? "Switch to night" : "Switch to day"}
        aria-label={day ? "Switch to night" : "Switch to day"}
        className="absolute right-[12%] top-[10%] cursor-pointer border-0 bg-transparent p-1 transition-transform hover:scale-110"
        style={{ pointerEvents: "auto" }}
      >
        {day ? <PixelSun /> : <PixelMoon />}
      </button>
      {CLOUDS.slice(0, 6).map((cloud, i) => (
        <div
          key={`c${i}`}
          className="cloud-drift absolute"
          style={{
            top: cloud.top,
            color: day ? "#ffffff" : "#cfd4ea",
            opacity: day ? cloud.opacity * 3 : cloud.opacity * 0.8,
            animationDuration: `${cloud.duration}s`,
            animationDelay: `${cloud.delay}s`,
          }}
        >
          <PixelCloud size={cloud.size} />
        </div>
      ))}
      {!day &&
        DUSK_STARS.map((star, i) => (
          <div
            key={`s${i}`}
            className="star-twinkle absolute"
            style={{ top: star.top, left: star.left, color: "#f5c542", animationDelay: `${star.delay}s` }}
          >
            <PixelSparkle size={star.size} />
          </div>
        ))}
      {!day && (
        <div className="shooting-star absolute" style={{ top: "14%", left: "70%", color: "#f5e3c2" }}>
          <PixelSparkle size={8} />
        </div>
      )}

      {/* skyline (edge to edge) */}
      <PixelCity day={day} />

      {/* two-lane road */}
      <div
        className="absolute inset-x-0 bottom-[7vh] h-[9vh] transition-colors duration-700"
        style={{ background: day ? "#4a4e59" : "#15131f" }}
      />
      <div
        className="absolute inset-x-0 bottom-[11.3vh] h-[3px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${
            day ? "rgba(255,255,255,0.55)" : "rgba(242,193,78,0.4)"
          } 0 18px, transparent 18px 42px)`,
        }}
      />
      {CARS.map((car, i) => (
        <div
          key={`car${i}`}
          className="cloud-drift absolute"
          style={{
            bottom: car.bottom,
            animationDuration: `${car.duration}s`,
            animationDelay: `${car.delay}s`,
            animationDirection: car.reverse ? "reverse" : "normal",
          }}
        >
          <div style={car.reverse ? { transform: "scaleX(-1)" } : undefined}>
            <PixelCar color={car.color} size={car.size} />
          </div>
        </div>
      ))}

      {/* curb divider with street lamps between road and footpath */}
      <div
        className="absolute inset-x-0 bottom-[6.4vh] h-[0.6vh] transition-colors duration-700"
        style={{ background: day ? "#8f939c" : "#221f30" }}
      />
      {LAMP_POSITIONS.map((left, i) => (
        <div key={`lamp${i}`} className="absolute bottom-[7vh]" style={{ left }}>
          <StreetLamp day={day} />
        </div>
      ))}

      {/* stone footpath — the dude's turf */}
      <div
        className="absolute inset-x-0 bottom-0 h-[6.4vh] transition-colors duration-700"
        style={{
          background: day ? "#b0b3ba" : "#1d1a28",
          backgroundImage: `repeating-linear-gradient(90deg, ${
            day ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.05)"
          } 0 2px, transparent 2px 30px), repeating-linear-gradient(180deg, ${
            day ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.04)"
          } 0 2px, transparent 2px 24px)`,
        }}
      />
      {/* legal line painted onto the pavement, road-marking style */}
      {roadText && (
        <p
          className="absolute inset-x-0 bottom-[2.4vh] text-center font-mono text-[11px] font-semibold uppercase tracking-[0.28em] transition-colors duration-700"
          style={{ color: day ? "rgba(50, 52, 62, 0.5)" : "rgba(255, 255, 255, 0.17)" }}
        >
          {roadText}
        </p>
      )}
      <div className="absolute inset-x-0 bottom-[0.6vh] h-0" style={{ pointerEvents: "auto" }}>
        <PixelPet working={false} size={56} idleStrollEveryMs={26_000} hopEveryMs={11_000} cap={day} />
      </div>
    </div>
  );
}
