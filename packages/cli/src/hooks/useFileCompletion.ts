/**
 * Hook that provides @ file autocomplete suggestions.
 *
 * When the input contains an "@" token, this hook:
 * 1. Recursively lists files in the current working directory (cached).
 * 2. Fuzzy-filters them with `fzf` against the partial path typed after "@".
 * 3. Returns the filtered list as Suggestion objects.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Fzf, type FzfResultItem } from "fzf";
import type { Suggestion } from "scout-core";

const MAX_SUGGESTIONS = 8;
const MAX_FILES = 2000; // cap to avoid perf issues on huge dirs

/**
 * Recursively collect file paths relative to `root`.
 * Skips hidden dirs, node_modules, __pycache__, and .git.
 */
function walkDir(root: string, base = ""): string[] {
  const results: string[] = [];
  const SKIP = new Set([
    "node_modules",
    "__pycache__",
    ".git",
    ".venv",
    "env",
    ".egg-info",
  ]);

  try {
    const entries = readdirSync(join(root, base), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".scout") continue;
      if (SKIP.has(entry.name)) continue;

      const rel = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        results.push(rel + "/");
        // Recurse (but cap total)
        if (results.length < MAX_FILES) {
          results.push(...walkDir(root, rel));
        }
      } else {
        results.push(rel);
      }
      if (results.length >= MAX_FILES) break;
    }
  } catch {
    // permission errors, etc.
  }
  return results;
}

interface UseFileCompletionResult {
  suggestions: Suggestion[];
  activeIndex: number;
  isActive: boolean;
  navigateUp: () => void;
  navigateDown: () => void;
  accept: () => string | null; // returns the value to insert
  dismiss: () => void;
}

export function useFileCompletion(
  inputValue: string,
  cwd: string = process.cwd()
): UseFileCompletionResult {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const filesCache = useRef<string[] | null>(null);
  const fzfRef = useRef<Fzf<string[]> | null>(null);

  // Detect if we're in @ mode: find the last "@" and extract the partial
  const atMatch = inputValue.match(/@([^\s]*)$/);
  const partial = atMatch ? atMatch[1] ?? "" : null;

  // Build/cache the file list
  useEffect(() => {
    if (partial === null) {
      setIsActive(false);
      setSuggestions([]);
      setActiveIndex(0);
      return;
    }

    // Lazy-build the file list cache
    if (!filesCache.current) {
      filesCache.current = walkDir(cwd);
      fzfRef.current = new Fzf(filesCache.current, {
        limit: MAX_SUGGESTIONS * 3,
      });
    }
  }, [partial, cwd]);

  // Filter suggestions when partial changes
  useEffect(() => {
    if (partial === null || !fzfRef.current) {
      setSuggestions([]);
      setIsActive(false);
      return;
    }

    setIsActive(true);

    if (!partial) {
      // Show first N files when "@" is typed with no path yet
      const top = (filesCache.current ?? []).slice(0, MAX_SUGGESTIONS);
      setSuggestions(
        top.map((f) => ({ label: f, value: f }))
      );
    } else {
      const results: FzfResultItem<string>[] = fzfRef.current.find(partial);
      setSuggestions(
        results
          .slice(0, MAX_SUGGESTIONS)
          .map((r: FzfResultItem<string>) => ({ label: r.item, value: r.item }))
      );
    }
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
