/**
 * Shared widgets for the Scout deploy TUI.
 *
 * Visual language: neutral dark chrome, solid-background chips for the
 * selected item (no neon outlines), dim gray for everything inactive.
 * All interaction is arrow keys + Enter; Esc steps back; ↑ from the top
 * of a screen hands focus to the step bar.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "scout-core/theme";

/** Solid chip backgrounds / ink. */
export const chip = {
  selectedBg: "#E4E4E4",
  selectedFg: "#1C1C1C",
  focusBg: "#3A3A3A",
};

/* ── Live terminal size (re-renders on resize) ───────────── */

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

/* ── Footer keybinding hints ─────────────────────────────── */

export interface KeyHint {
  keys: string;
  label: string;
}

export const KeyHints: React.FC<{ hints: KeyHint[] }> = ({ hints }) => (
  <Box>
    {hints.map((hint, index) => (
      <Text key={hint.keys}>
        {index > 0 && <Text color={theme.brand.frame}>  </Text>}
        <Text color={theme.text.primary} bold>
          {hint.keys}
        </Text>
        <Text color={theme.text.secondary}> {hint.label}</Text>
      </Text>
    ))}
  </Box>
);

/* ── Step trail: focusable tab bar ───────────────────────── */

export const StepTrail: React.FC<{
  steps: string[];
  current: number;
  /** Steps the user may open. */
  reachable?: boolean[];
  /** Bar has keyboard focus. */
  focused?: boolean;
  /** Highlighted step while the bar is focused. */
  cursor?: number;
}> = ({ steps, current, reachable, focused, cursor }) => (
  <Box>
    {steps.map((step, index) => {
      const active = index === current;
      const canOpen = reachable?.[index] ?? true;
      const highlighted = focused && index === cursor;
      if (highlighted)
        return (
          <Text key={step} backgroundColor={canOpen ? chip.selectedBg : chip.focusBg} color={canOpen ? chip.selectedFg : theme.text.secondary} bold>
            {` ${step} `}
          </Text>
        );
      if (active)
        return (
          <Text key={step} backgroundColor={focused ? chip.focusBg : chip.selectedBg} color={focused ? theme.text.primary : chip.selectedFg} bold>
            {` ${step} `}
          </Text>
        );
      return (
        <Text key={step} color={canOpen ? theme.text.secondary : theme.brand.frame}>
          {` ${step} `}
        </Text>
      );
    })}
  </Box>
);

/* ── Horizontal chip selector (←/→, Enter, Esc, ↑) ───────── */

export interface CardOption {
  label: string;
  /** One-line description shown under the row while selected. */
  blurb?: string;
  /** Small tag rendered inside the chip, e.g. "GPU". */
  tag?: string;
}

export const CardRow: React.FC<{
  options: CardOption[];
  /** Per-chip configured state: ✓ when true, dim gray when false. */
  checked?: boolean[];
  initialIndex?: number;
  onSubmit: (index: number) => void;
  onBack?: () => void;
  /** ↑ pressed — used to hand focus to the step bar. */
  onUp?: () => void;
  isActive?: boolean;
}> = ({ options, checked, initialIndex = 0, onSubmit, onBack, onUp, isActive = true }) => {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, options.length - 1)));

  useInput(
    (_input, key) => {
      if (key.leftArrow) setIndex((prev) => (prev + options.length - 1) % options.length);
      else if (key.rightArrow || key.tab) setIndex((prev) => (prev + 1) % options.length);
      else if (key.upArrow && onUp) onUp();
      else if (key.return) onSubmit(index);
      else if (key.escape && onBack) onBack();
    },
    { isActive },
  );

  const active = options[index]!;
  return (
    <Box flexDirection="column">
      <Box>
        {options.map((option, optionIndex) => {
          const selected = optionIndex === index;
          const on = checked?.[optionIndex];
          const label = option.tag ? `${option.label} · ${option.tag}` : option.label;
          return (
            <Box key={option.label} marginRight={2}>
              <Text
                backgroundColor={selected ? (isActive ? chip.selectedBg : chip.focusBg) : undefined}
                color={
                  selected
                    ? isActive
                      ? chip.selectedFg
                      : theme.text.primary
                    : on
                      ? theme.text.primary
                      : checked
                        ? theme.brand.frame
                        : theme.text.secondary
                }
                bold={selected || on}
              >
                {` ${on ? "✓ " : ""}${label} `}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} height={1}>
        {active.blurb && <Text color={theme.text.secondary}>{active.blurb}</Text>}
      </Box>
    </Box>
  );
};

/* ── Horizontal multi-select chips (←/→, space, Enter, ↑) ── */

export interface ToggleOption {
  label: string;
  tag?: string;
  blurb?: string;
}

export const ToggleRow: React.FC<{
  options: ToggleOption[];
  checked: boolean[];
  initialIndex?: number;
  onToggle: (index: number) => void;
  /** Enter on a chip — receives the highlighted index. */
  onSubmit: (index: number) => void;
  onBack?: () => void;
  onUp?: () => void;
  isActive?: boolean;
}> = ({ options, checked, initialIndex = 0, onToggle, onSubmit, onBack, onUp, isActive = true }) => {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, options.length - 1)));

  useInput(
    (input, key) => {
      if (key.leftArrow) setIndex((prev) => (prev + options.length - 1) % options.length);
      else if (key.rightArrow || key.tab) setIndex((prev) => (prev + 1) % options.length);
      else if (key.upArrow && onUp) onUp();
      else if (input === " ") onToggle(index);
      else if (key.return) onSubmit(index);
      else if (key.escape && onBack) onBack();
    },
    { isActive },
  );

  const active = options[index]!;
  return (
    <Box flexDirection="column">
      <Box>
        {options.map((option, optionIndex) => {
          const cursor = optionIndex === index;
          const on = checked[optionIndex];
          const label = option.tag ? `${option.label} · ${option.tag}` : option.label;
          return (
            <Box key={option.label} marginRight={2}>
              <Text
                backgroundColor={cursor ? (isActive ? chip.selectedBg : chip.focusBg) : undefined}
                color={cursor ? (isActive ? chip.selectedFg : theme.text.primary) : on ? theme.text.primary : theme.text.secondary}
                bold={cursor || on}
              >
                {` ${on ? "✓ " : ""}${label} `}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} height={1}>
        {active.blurb && <Text color={theme.text.secondary}>{active.blurb}</Text>}
      </Box>
    </Box>
  );
};

/* ── Vertical select list (↑/↓, Enter, Esc) ──────────────── */

export interface ListOption {
  label: string;
  detail?: string;
  /** Badge rendered after the row, e.g. "✓ default". */
  badge?: string;
}

export const SelectList: React.FC<{
  options: ListOption[];
  initialIndex?: number;
  onSubmit: (index: number) => void;
  onBack?: () => void;
  /** ↑ pressed on the first item — hand focus to the step bar. */
  onUp?: () => void;
  /** `d` pressed on a row (e.g. mark as default model). */
  onMark?: (index: number) => void;
  isActive?: boolean;
}> = ({ options, initialIndex = 0, onSubmit, onBack, onUp, onMark, isActive = true }) => {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, options.length - 1)));

  useInput(
    (input, key) => {
      if (key.upArrow) {
        if (index === 0 && onUp) onUp();
        else setIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow || key.tab) setIndex((prev) => Math.min(options.length - 1, prev + 1));
      else if (key.return) onSubmit(index);
      else if (input === "d" && onMark) onMark(index);
      else if (key.escape && onBack) onBack();
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {options.map((option, optionIndex) => {
        const selected = optionIndex === index;
        const text = option.detail ? `${option.label}  —  ${option.detail}` : option.label;
        return (
          <Box key={option.label}>
            <Text
              backgroundColor={selected ? (isActive ? chip.selectedBg : chip.focusBg) : undefined}
              color={selected ? (isActive ? chip.selectedFg : theme.text.primary) : theme.text.secondary}
              bold={selected}
            >
              {` ${text} `}
            </Text>
            {option.badge && <Text color={theme.status.success}>  {option.badge}</Text>}
          </Box>
        );
      })}
    </Box>
  );
};

/* ── Text input that ignores ctrl/alt chords ─────────────── */

const TextField: React.FC<{
  value: string;
  placeholder?: string;
  mask?: boolean;
  isActive: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}> = ({ value, placeholder, mask, isActive, onChange, onSubmit }) => {
  const [cursor, setCursor] = useState(value.length);

  useEffect(() => {
    setCursor((prev) => Math.min(prev, value.length));
  }, [value]);

  useInput(
    (input, key) => {
      if (key.return) return onSubmit();
      if (key.leftArrow) return setCursor((prev) => Math.max(0, prev - 1));
      if (key.rightArrow) return setCursor((prev) => Math.min(value.length, prev + 1));
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          onChange(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor((prev) => prev - 1);
        }
        return;
      }
      // Chords and navigation keys never type: ctrl+n must not insert "n".
      if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow || key.tab) return;
      if (input && !input.startsWith("\x1b")) {
        onChange(value.slice(0, cursor) + input + value.slice(cursor));
        setCursor((prev) => prev + input.length);
      }
    },
    { isActive },
  );

  const shown = mask ? "•".repeat(value.length) : value;
  if (!isActive) {
    return <Text color={theme.text.secondary}>{shown || placeholder || ""}</Text>;
  }
  if (!shown) {
    return (
      <Text>
        <Text backgroundColor={chip.selectedBg} color={chip.selectedFg}>
          {" "}
        </Text>
        <Text color={theme.brand.frame}> {placeholder ?? ""}</Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={theme.text.primary}>{shown.slice(0, cursor)}</Text>
      <Text backgroundColor={chip.selectedBg} color={chip.selectedFg}>
        {cursor < shown.length ? shown[cursor] : " "}
      </Text>
      <Text color={theme.text.primary}>{cursor < shown.length ? shown.slice(cursor + 1) : ""}</Text>
    </Text>
  );
};

/* ── Labelled field ──────────────────────────────────────── */

export const Field: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  mask?: boolean;
  focused?: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}> = ({ label, value, placeholder, mask, focused = true, error, onChange, onSubmit }) => (
  <Box flexDirection="column">
    <Box>
      <Text
        backgroundColor={focused ? chip.selectedBg : undefined}
        color={focused ? chip.selectedFg : theme.text.secondary}
        bold={focused}
      >
        {` ${label} `}
      </Text>
    </Box>
    <Box marginTop={1} marginLeft={1}>
      <Text color={focused ? theme.text.primary : theme.brand.frame}>{"> "}</Text>
      <TextField
        value={value}
        placeholder={placeholder}
        mask={mask}
        isActive={focused}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    </Box>
    {error && (
      <Box marginLeft={3}>
        <Text color={theme.status.error}>{error}</Text>
      </Box>
    )}
  </Box>
);
