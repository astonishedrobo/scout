/**
 * Fixed sprite palette, shared by every pixel-art component.
 *
 * Deliberately NOT theme tokens: the theme desaturates the brand colours in
 * dark and `soft` (which is the default), and a mascot that greys out with the
 * workspace reads as broken rather than tasteful.
 *
 * It lives here because the same table was duplicated byte-for-byte in
 * PixelPet and PixelArt, and the accent triad again in ScoutMark — three copies
 * with no way to notice when one drifted.
 */
export const SPRITE = {
  skin: "#f2a76b",
  hair: "#f5c542",
  shirt: "#8f78ef",
  pants: "var(--sprite-pants)",
  shoes: "var(--sprite-shoes)",
  dark: "#17181c",
} as const;

/** Brand accent triad used by the mark and the sparkles. */
export const BRAND = {
  lavender: "#a78bfa",
  peach: "#f0a058",
  amber: "#f5c542",
} as const;
