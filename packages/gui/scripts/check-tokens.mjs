/**
 * Guard against invented Tailwind utility names.
 *
 * Tailwind resolves an unknown class to *nothing*, silently. That is how
 * `bg-scout-accent` (the token is `accent-cta`) and `shadow-card` (the token is
 * `card-hover`) shipped: four elements rendered with no colour and no shadow,
 * and neither tsc nor the build said a word.
 *
 * This checks every `scout-*` colour utility and every custom-scale utility
 * (shadow / rounded / duration / ease) in the source against the names actually
 * declared in tailwind.config.js. Run via `npm run check:tokens`, and as part of
 * `npm run build`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = (await import(join(root, "tailwind.config.js"))).default;
const extend = config.theme.extend;

const scoutColors = new Set(Object.keys(extend.colors.scout));
// Custom scales *extend* Tailwind's defaults, so the built-in names stay legal.
const scales = {
  shadow: new Set([...Object.keys(extend.boxShadow), "sm", "", "md", "lg", "xl", "2xl", "inner", "none"]),
  rounded: new Set([...Object.keys(extend.borderRadius), "none", "sm", "", "md", "lg", "xl", "2xl", "3xl", "full"]),
  duration: new Set([...Object.keys(extend.transitionDuration), "0", "75", "100", "150", "200", "300", "500", "700", "1000"]),
  ease: new Set([...Object.keys(extend.transitionTimingFunction), "linear", "in", "out", "in-out"]),
};

// Colour utilities that can take a scout token.
const COLOR_PREFIXES =
  "bg|text|border|border-[trblxy]|from|via|to|fill|stroke|ring|ring-offset|divide|outline|decoration|caret|accent|shadow|placeholder";

const colorRe = new RegExp(`\\b(?:${COLOR_PREFIXES})-scout-([a-z0-9-]+)(?:\\/[a-z0-9.[\\]%]+)?\\b`, "g");
const scaleRe = new RegExp(
  `\\b(?:hover:|focus:|focus-visible:|active:|group-hover:|disabled:|sm:|md:|lg:|xl:)*` +
    `(shadow|rounded-[trbl][lr]|rounded-[trblse]|rounded|duration|ease)-(\\[[^\\]]+\\]|[a-z0-9-]+)(?![-\\w])`,
  "g",
);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|css|html)$/.test(name)) out.push(full);
  }
  return out;
}

const problems = [];

for (const file of [...walk(join(root, "src")), join(root, "index.html")]) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const at = () => `${relative(root, file)}:${i + 1}`;

    for (const [, token] of line.matchAll(colorRe)) {
      // `scout-` is also a plain string prefix in places (localStorage keys,
      // CSS custom properties); only flag it where it is a real utility.
      if (!scoutColors.has(token)) {
        problems.push(`${at()}  unknown colour token: scout-${token}`);
      }
    }
    for (const [, scale, token] of line.matchAll(scaleRe)) {
      const base = scale.split("-")[0];
      const allowed = scales[base];
      if (!allowed) continue;
      // Arbitrary values (`rounded-[26px]`) and scout colours (`shadow-scout-*`,
      // `border-scout-*`) are handled elsewhere or intentionally raw.
      if (token.startsWith("[") || token.startsWith("scout")) continue;
      if (!allowed.has(token)) {
        problems.push(`${at()}  unknown ${base} value: ${scale}-${token}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(
    `\nTailwind emits nothing for an unknown utility name, so these render unstyled:\n`,
  );
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} problem(s).\n`);
  process.exit(1);
}

console.log("check-tokens: all scout/shadow/rounded/duration/ease utilities resolve.");
