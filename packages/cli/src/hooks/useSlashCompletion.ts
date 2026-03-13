/**
 * Hook that provides / slash command autocomplete suggestions.
 *
 * When the input starts with "/", this hook fuzzy-filters the known
 * command list and returns matching suggestions.
 */

import { useState, useEffect, useCallback } from "react";
import { SLASH_COMMANDS, type Suggestion } from "scout-core";

interface UseSlashCompletionResult {
  suggestions: Suggestion[];
  activeIndex: number;
  isActive: boolean;
  navigateUp: () => void;
  navigateDown: () => void;
  accept: () => string | null; // returns the full command name
  dismiss: () => void;
}

export function useSlashCompletion(
  inputValue: string
): UseSlashCompletionResult {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isActive, setIsActive] = useState(false);

  // Only activate when the input starts with "/"
  const startsWithSlash = inputValue.startsWith("/");
  const partial = startsWithSlash ? inputValue.toLowerCase() : null;

  useEffect(() => {
    if (partial === null) {
      setIsActive(false);
      setSuggestions([]);
      setActiveIndex(0);
      return;
    }

    setIsActive(true);

    // Filter commands: simple prefix + substring matching
    const filtered = SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.name.toLowerCase().startsWith(partial) ||
        cmd.name.toLowerCase().includes(partial.slice(1))
    ).map((cmd) => ({
      label: cmd.name,
      value: cmd.name,
      description: cmd.description,
    }));

    setSuggestions(filtered);
    setActiveIndex(0);
  }, [partial]);

  const navigateUp = useCallback(() => {
    setActiveIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const navigateDown = useCallback(() => {
    setActiveIndex((prev) =>
      Math.min(suggestions.length - 1, prev + 1)
    );
  }, [suggestions.length]);

  const accept = useCallback((): string | null => {
    if (suggestions.length === 0) return null;
    const selected = suggestions[activeIndex];
    if (!selected) return null;
    setIsActive(false);
    setSuggestions([]);
    return selected.value;
  }, [suggestions, activeIndex]);

  const dismiss = useCallback(() => {
    setIsActive(false);
    setSuggestions([]);
    setActiveIndex(0);
  }, []);

  return {
    suggestions,
    activeIndex,
    isActive,
    navigateUp,
    navigateDown,
    accept,
    dismiss,
  };
}
