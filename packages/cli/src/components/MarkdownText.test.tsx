import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { MarkdownText } from "./MarkdownText.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("MarkdownText", () => {
  /* ── Basic rendering ─────────────────────────────────────── */

  it("renders empty string without crashing", () => {
    const { lastFrame } = render(<MarkdownText width={80}>{""}</MarkdownText>);
    expect(lastFrame()).toBeDefined();
  });

  it("renders a plain paragraph", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"Hello world"}</MarkdownText>,
    );
    expect(strip(lastFrame()!)).toContain("Hello world");
  });

  /* ── Inline formatting ───────────────────────────────────── */

  it("renders bold text", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"This is **bold** text"}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("bold");
    expect(text).toContain("This is");
  });

  it("renders italic text", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"This is *italic* text"}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("italic");
    expect(text).toContain("This is");
  });

  it("renders inline code", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"Use `console.log`"}</MarkdownText>,
    );
    expect(strip(lastFrame()!)).toContain("console.log");
  });

  /* ── Headings ────────────────────────────────────────────── */

  it("renders headings", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"# Title\n\nParagraph"}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("Title");
    expect(text).toContain("Paragraph");
  });

  /* ── Lists ───────────────────────────────────────────────── */

  it("renders an unordered list", () => {
    const md = "- Apple\n- Banana\n- Cherry";
    const { lastFrame } = render(
      <MarkdownText width={80}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("Apple");
    expect(text).toContain("Banana");
    expect(text).toContain("Cherry");
  });

  it("renders an ordered list", () => {
    const md = "1. First\n2. Second\n3. Third";
    const { lastFrame } = render(
      <MarkdownText width={80}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toMatch(/1[.)]/);
    expect(text).toContain("First");
    expect(text).toContain("Third");
  });

  /* ── Code blocks ─────────────────────────────────────────── */

  it("renders a fenced code block", () => {
    const md = "```python\nprint('hello')\n```";
    const { lastFrame } = render(
      <MarkdownText width={80}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("print");
    expect(text).toContain("hello");
  });

  /* ── GFM tables ──────────────────────────────────────────── */

  it("renders a simple GFM table with box-drawing chars", () => {
    const md = [
      "| Name  | Value |",
      "|-------|-------|",
      "| Alpha | 0.1   |",
      "| Beta  | 0.2   |",
    ].join("\n");

    const { lastFrame } = render(
      <MarkdownText width={80}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("Name");
    expect(text).toContain("Alpha");
    expect(text).toContain("0.2");
    expect(text).toContain("┌");
    expect(text).toContain("│");
    expect(text).toContain("└");
  });

  it("handles a table with long cell content — cells word-wrap, borders stay intact", () => {
    const md = [
      "| Metric | Value | Source |",
      "|--------|-------|--------|",
      "| Overall mean CVI | 0.421 | meta_files/climate.csv (average of 252 blocks in West Bengal) |",
      "| Mean exposure component | 0.288 | same file |",
    ].join("\n");

    const { lastFrame } = render(
      <MarkdownText width={100}>{md}</MarkdownText>,
    );
    const frame = lastFrame()!;
    const text = strip(frame);

    expect(text).toContain("Overall mean CVI");
    expect(text).toContain("0.421");
    expect(text).toContain("0.288");

    // Every data line (with │ but not border chars) must start and end with │
    const dataLines = strip(frame)
      .split("\n")
      .filter((l) => l.includes("│") && !l.includes("┌") && !l.includes("└") && !l.includes("├"));
    for (const line of dataLines) {
      const trimmed = line.trim();
      expect(trimmed.startsWith("│")).toBe(true);
      expect(trimmed.endsWith("│")).toBe(true);
    }
  });

  it("renders a table with many columns correctly", () => {
    const md = [
      "| Block | CVI | Exposure | Sensitivity | Adaptive-capacity |",
      "|-------|-----|----------|-------------|-------------------|",
      "| Bajiagaon | 0.389 | 0.258 | 0.383 | 0.252 |",
      "| Barhampur | 0.387 | 0.255 | 0.414 | 0.283 |",
    ].join("\n");

    const { lastFrame } = render(
      <MarkdownText width={100}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("Bajiagaon");
    expect(text).toContain("0.389");
    expect(text).toContain("Adaptive-capacity");
    expect(text).toContain("0.283");
  });

  it("handles narrow width without crashing", () => {
    const md = [
      "| A very long header | Another long header | Yet another |",
      "|---|---|---|",
      "| data1 | data2 | data3 |",
    ].join("\n");

    const { lastFrame } = render(
      <MarkdownText width={40}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("data1");
  });

  /* ── Blockquotes ─────────────────────────────────────────── */

  it("renders blockquotes", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"> This is a quote"}</MarkdownText>,
    );
    expect(strip(lastFrame()!)).toContain("This is a quote");
  });

  /* ── Mixed content ───────────────────────────────────────── */

  it("renders mixed markdown (heading + paragraph + list + table)", () => {
    const md = [
      "# Report",
      "",
      "Summary of findings.",
      "",
      "- Item A",
      "- Item B",
      "",
      "| Col1 | Col2 |",
      "|------|------|",
      "| X    | Y    |",
    ].join("\n");

    const { lastFrame } = render(
      <MarkdownText width={80}>{md}</MarkdownText>,
    );
    const text = strip(lastFrame()!);
    expect(text).toContain("Report");
    expect(text).toContain("Summary of findings");
    expect(text).toContain("Item A");
    expect(text).toContain("Item B");
    expect(text).toContain("X");
    expect(text).toContain("Y");
  });

  /* ── Width constraint ────────────────────────────────────── */

  it("respects the width prop — narrow ≤ wide", () => {
    const md = [
      "| A long header column name | Another long header column | Yet another one |",
      "|---|---|---|",
      "| data1 | data2 | data3 |",
    ].join("\n");

    const narrow = render(<MarkdownText width={50}>{md}</MarkdownText>);
    const wide = render(<MarkdownText width={120}>{md}</MarkdownText>);

    const narrowText = strip(narrow.lastFrame()!);
    const wideText = strip(wide.lastFrame()!);

    expect(narrowText).toContain("data1");
    expect(wideText).toContain("data1");

    const maxLineLen = (s: string) =>
      Math.max(...s.split("\n").map((l) => l.length));
    expect(maxLineLen(narrowText)).toBeLessThanOrEqual(maxLineLen(wideText));

    narrow.cleanup();
    wide.cleanup();
  });

  /* ── Trailing newlines ───────────────────────────────────── */

  it("does not produce excessive trailing newlines", () => {
    const { lastFrame } = render(
      <MarkdownText width={80}>{"Hello"}</MarkdownText>,
    );
    expect(lastFrame()!.endsWith("\n\n")).toBe(false);
  });
});
