import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ResponseAnnotation } from "scout-core";

interface SelectionDraft {
  quote: string;
  contextBefore: string;
  contextAfter: string;
  rect: DOMRect;
  rects: DOMRect[];
}

interface MarkerPosition {
  annotation: ResponseAnnotation;
  rects: DOMRect[];
  marker: DOMRect;
}

interface AnnotationRegionProps {
  sourceId: string;
  annotations: ResponseAnnotation[];
  annotationNumbers: Map<string, number>;
  onAdd: (annotation: Omit<ResponseAnnotation, "id" | "createdAt" | "updatedAt">) => void;
  onUpdate: (id: string, changes: Pick<ResponseAnnotation, "comment">) => void;
  onRemove: (id: string) => void;
  children: ReactNode;
}

function textNodes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest("[data-no-annotation]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) nodes.push(current as Text);
  return nodes;
}

function makeRange(root: HTMLElement, quote: string, before = "", after = "") {
  const nodes = textNodes(root);
  const text = nodes.map((node) => node.data).join("");
  if (!quote || !text) return null;
  let offset = -1;
  if (before || after) {
    const startAt = before ? Math.max(0, text.indexOf(before) + before.length) : 0;
    const candidate = text.indexOf(quote, startAt);
    if (candidate >= 0 && (!after || text.slice(candidate + quote.length).startsWith(after))) offset = candidate;
  }
  if (offset < 0) offset = text.indexOf(quote);
  if (offset < 0) return null;

  const end = offset + quote.length;
  let cursor = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const node of nodes) {
    const next = cursor + node.data.length;
    if (!startNode && offset >= cursor && offset <= next) {
      startNode = node;
      startOffset = offset - cursor;
    }
    if (end >= cursor && end <= next) {
      endNode = node;
      endOffset = end - cursor;
      break;
    }
    cursor = next;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

// clientWidth excludes the scrollbar — innerWidth doesn't, which let popups
// spill past the visible edge and cause horizontal scroll.
function viewportWidth() {
  return document.documentElement.clientWidth;
}

function selectionActionPosition(rect: DOMRect) {
  return {
    left: Math.max(12, Math.min(rect.left, viewportWidth() - 130)),
    top: Math.max(12, rect.top - 42),
  };
}

// Codex-style: the composer sits right next to the selection — just below it,
// horizontally aligned with where the selection starts, always on-screen.
function editorPositionFor(rect: DOMRect) {
  const width = Math.min(520, viewportWidth() - 24);
  const height = 170;
  const left = Math.max(12, Math.min(rect.left, viewportWidth() - width - 12));
  const below = rect.bottom + 10;
  const top = below + height <= window.innerHeight - 12
    ? below
    : Math.max(12, rect.top - height - 10);
  return { left, top, width };
}

/** Makes a rendered assistant text block selectable and overlays durable annotation markers. */
export function AnnotationRegion({
  sourceId,
  annotations,
  annotationNumbers,
  onAdd,
  onUpdate,
  onRemove,
  children,
}: AnnotationRegionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState<SelectionDraft | null>(null);
  const [editing, setEditing] = useState<ResponseAnnotation | null>(null);
  const [comment, setComment] = useState("");
  const [markers, setMarkers] = useState<MarkerPosition[]>([]);
  const [editorAnchor, setEditorAnchor] = useState<DOMRect | null>(null);

  const refreshMarkers = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = annotations.flatMap((annotation) => {
      const range = makeRange(root, annotation.quote, annotation.contextBefore, annotation.contextAfter);
      const rects = range ? Array.from(range.getClientRects()) : [];
      const marker = rects[rects.length - 1];
      return marker ? [{ annotation, rects, marker }] : [];
    });
    setMarkers(next);
  }, [annotations]);

  useLayoutEffect(() => {
    refreshMarkers();
    const observer = new ResizeObserver(refreshMarkers);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener("resize", refreshMarkers);
    window.addEventListener("scroll", refreshMarkers, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refreshMarkers);
      window.removeEventListener("scroll", refreshMarkers, true);
    };
  }, [refreshMarkers]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelection(null);
      setEditing(null);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, []);

  // Dismiss the "Add note" pill when the user clicks elsewhere and the text
  // selection collapses. The pill itself prevents mousedown default so
  // clicking it doesn't clear the selection before its click handler runs.
  useEffect(() => {
    if (!selection || editing) return;
    const onSelectionChange = () => {
      const current = window.getSelection();
      if (!current || current.isCollapsed) setSelection(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [selection, editing]);

  const captureSelection = useCallback(() => {
    const root = rootRef.current;
    const selected = window.getSelection();
    if (!root || !selected || selected.rangeCount === 0 || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const quote = selected.toString().replace(/\s+/g, " ").trim();
    if (!quote) return;
    const whole = root.textContent ?? "";
    const original = selected.toString();
    const index = whole.indexOf(original);
    const rects = Array.from(range.getClientRects());
    const rect = rects[0] ?? range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    setEditing(null);
    setSelection({
      quote,
      contextBefore: index >= 0 ? whole.slice(Math.max(0, index - 100), index) : "",
      contextAfter: index >= 0 ? whole.slice(index + original.length, index + original.length + 100) : "",
      rect,
      rects,
    });
  }, []);

  const openNewEditor = useCallback(() => {
    if (!selection) return;
    setComment("");
    setEditorAnchor(selection.rect);
    setEditing({
      id: "new",
      sourceId,
      quote: selection.quote,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      comment: "",
      createdAt: "",
      updatedAt: "",
    });
  }, [selection, sourceId]);

  const openEdit = useCallback((annotation: ResponseAnnotation) => {
    setSelection(null);
    setComment(annotation.comment);
    setEditing(annotation);
    const marker = markers.find((item) => item.annotation.id === annotation.id)?.marker;
    setEditorAnchor(marker ?? null);
  }, [markers]);

  const save = useCallback(() => {
    if (!editing) return;
    if (editing.id === "new") {
      onAdd({
        sourceId: editing.sourceId,
        quote: editing.quote,
        contextBefore: editing.contextBefore,
        contextAfter: editing.contextAfter,
        comment,
      });
    } else {
      onUpdate(editing.id, { comment });
    }
    setEditing(null);
    setSelection(null);
    setComment("");
  }, [comment, editing, onAdd, onUpdate]);

  const editorPosition = useMemo(() => editing
    ? editorPositionFor(editorAnchor ?? markers.find((item) => item.annotation.id === editing.id)?.marker ?? new DOMRect(16, 80, 0, 0))
    : null,
  [editing, editorAnchor, markers]);

  const rootRect = rootRef.current?.getBoundingClientRect();

  return (
    <div ref={rootRef} className="annotation-region relative" onMouseUp={captureSelection} onTouchEnd={captureSelection}>
      {children}
      {rootRect && editing?.id === "new" && selection?.rects.map((rect, index) => (
        <span
          key={`draft-${index}`}
          aria-hidden="true"
          className="annotation-highlight"
          style={{ left: rect.left - rootRect.left, top: rect.top - rootRect.top, width: rect.width, height: rect.height }}
        />
      ))}
      {rootRect && markers.map(({ annotation, rects, marker }) => (
        <span key={annotation.id}>
          {rects.map((rect, index) => (
            <span
              key={index}
              aria-hidden="true"
              className="annotation-highlight"
              style={{ left: rect.left - rootRect.left, top: rect.top - rootRect.top, width: rect.width, height: rect.height }}
            />
          ))}
          <button
            type="button"
            data-no-annotation
            onClick={() => openEdit(annotation)}
            className="annotation-marker"
            style={{ left: marker.right - rootRect.left + 4, top: marker.top - rootRect.top - 8 }}
            aria-label={`Edit annotation ${annotationNumbers.get(annotation.id) ?? 1}`}
          >
            {annotationNumbers.get(annotation.id) ?? 1}
          </button>
        </span>
      ))}

      {/* The pill and editor MUST portal to <body>: position:fixed resolves
          against the nearest transformed/filtered ancestor, and chat messages
          animate with transforms — inside the tree these land anywhere. */}
      {selection && !editing && createPortal(
        <button
          type="button"
          data-no-annotation
          onMouseDown={(event) => event.preventDefault()}
          onClick={openNewEditor}
          className="annotation-selection-action fixed z-[75] w-auto whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-bold"
          style={selectionActionPosition(selection.rect)}
        >
          Add note
        </button>,
        document.body,
      )}

      {editing && editorPosition && createPortal(
        <div
          data-no-annotation
          role="dialog"
          aria-label={editing.id === "new" ? "Add annotation" : "Edit annotation"}
          className="annotation-editor fixed z-[80] flex flex-col rounded-2xl border border-scout-hairline-faint bg-scout-panel p-3.5 shadow-pop"
          style={editorPosition}
        >
          <textarea
            ref={inputRef}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") save();
              if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                save();
              }
            }}
            placeholder="Add an optional comment…"
            rows={3}
            className="min-h-[72px] w-full flex-1 resize-none border-0 bg-transparent px-1 py-1 text-[15px] leading-relaxed text-scout-text outline-none placeholder:text-scout-muted/70"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                if (editing.id !== "new") onRemove(editing.id);
                setEditing(null);
                setSelection(null);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full text-scout-muted hover:bg-scout-error-muted hover:text-scout-error"
              aria-label={editing.id === "new" ? "Discard annotation" : "Delete annotation"}
            >
              <Trash2 size={16} />
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => { setEditing(null); setSelection(null); }} className="rounded-full border border-scout-hairline-faint bg-scout-lift px-4 py-1.5 text-sm font-medium text-scout-text hover:bg-scout-input-bg">Cancel</button>
              <button type="button" onClick={save} className="rounded-full bg-scout-text px-4 py-1.5 text-sm font-semibold text-scout-bg hover:opacity-90">Save</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
