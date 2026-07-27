/**
 * Shared optical sizes for the application icon language.
 *
 * Lucide's default stroke is the source of truth for standard icons. Only
 * terminal primary actions get a slightly stronger stroke; bespoke panel
 * controls own their geometry and are intentionally outside this scale.
 */
export const ICON_SIZE = {
  inline: 13,
  compact: 14,
  feature: 15,
  toolbar: 16,
  primary: 18,
} as const;

export const ICON_STROKE = {
  standard: 2,
  primary: 2.25,
} as const;
