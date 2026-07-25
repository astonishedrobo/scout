import { Cloud, Moon, Sun } from "lucide-react";
import { SettingsGroup, SettingsRow, Segmented, Switch } from "../ui";
import { useTheme, type Theme } from "../../hooks/useTheme";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useLocalSetting } from "../../hooks/useLocalSetting";

/**
 * One theme preview.
 *
 * The `swatch-*` classes come from globals.css and set `--swatch-*`, so each
 * preview paints itself in the theme it represents without JS.
 */
function ThemeCard({
  icon,
  label,
  active,
  onClick,
  swatch,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  swatch: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col items-center gap-2 rounded-card p-1 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-scout-text/30 ${
        active
          ? // Offsets against the panel fill this now sits on, not scout-bg —
            // the old value left a dark halo around the selected card.
            "ring-2 ring-scout-text ring-offset-2 ring-offset-scout-panel"
          : "hover:opacity-80"
      }`}
    >
      <div
        className={`relative h-[4.5rem] w-24 overflow-hidden rounded-card border border-scout-hairline ${swatch}`}
        style={{ backgroundColor: "var(--swatch-canvas)" }}
      >
        <div
          className="absolute bottom-0 left-0 top-0 w-6"
          style={{ backgroundColor: "var(--swatch-panel)", opacity: 0.9 }}
        />
        <div className="absolute left-8 right-2 top-3 space-y-1.5">
          <div className="h-1.5 w-3/4 rounded-full" style={{ backgroundColor: "var(--swatch-panel)" }} />
          <div className="h-1.5 w-1/2 rounded-full" style={{ backgroundColor: "var(--swatch-panel)" }} />
        </div>
        <div
          className="absolute bottom-2 left-8 right-2 h-3 rounded-full"
          style={{ backgroundColor: "var(--swatch-panel)", opacity: 0.7 }}
        />
        <div
          className="absolute bottom-2.5 right-3 h-2 w-2 rounded-full"
          style={{ backgroundColor: "var(--swatch-accent)" }}
        />
      </div>
      <span
        className={`flex items-center gap-1 text-caption ${
          active ? "font-semibold text-scout-text" : "font-medium text-scout-muted"
        }`}
      >
        <span aria-hidden="true">{icon}</span>
        {label}
      </span>
    </button>
  );
}

const THEMES: { value: Theme; label: string; icon: React.ReactNode; swatch: string }[] = [
  { value: "light", label: "Light", icon: <Sun size={13} />, swatch: "swatch-light" },
  { value: "dark", label: "Dark", icon: <Moon size={13} />, swatch: "swatch-dark" },
  { value: "soft", label: "Soft gray", icon: <Cloud size={13} />, swatch: "swatch-soft" },
];

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const systemReducedMotion = usePrefersReducedMotion();
  const [density, setDensity] = useLocalSetting<"comfortable" | "compact">(
    "appearance.density",
    "comfortable",
  );
  const [reduceMotion, setReduceMotion] = useLocalSetting(
    "appearance.reduceMotion",
    systemReducedMotion,
  );

  return (
    <>
      <SettingsGroup label="Color mode" description="Applies immediately and is remembered on this device.">
        <SettingsRow label="Theme" description="Soft gray is the default.">
          <div className="mt-3 flex flex-wrap gap-3">
            {THEMES.map((t) => (
              <ThemeCard
                key={t.value}
                icon={t.icon}
                label={t.label}
                swatch={t.swatch}
                active={theme === t.value}
                onClick={() => setTheme(t.value)}
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="Display" footnote="Saved on this device until the server setting lands.">
        <SettingsRow
          label="Density"
          description="Spacing in the conversation and panels."
          control={
            <Segmented
              value={density}
              onChange={setDensity}
              label="Density"
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Reduce motion"
          description={
            systemReducedMotion
              ? "Your system already asks for reduced motion, which Scout follows."
              : "Turn off entrance and exit animations."
          }
          control={
            <Switch
              checked={reduceMotion || systemReducedMotion}
              onChange={setReduceMotion}
              disabled={systemReducedMotion}
              label="Reduce motion"
            />
          }
        />
      </SettingsGroup>
    </>
  );
}
