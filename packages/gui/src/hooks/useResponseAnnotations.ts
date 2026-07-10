import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResponseAnnotation } from "scout-core";

const STORAGE_PREFIX = "scout-response-annotations:";

function keyFor(sessionId: string | null) {
  return `${STORAGE_PREFIX}${sessionId ?? "draft"}`;
}

function load(sessionId: string | null): ResponseAnnotation[] {
  try {
    const raw = localStorage.getItem(keyFor(sessionId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isAnnotation) : [];
  } catch {
    return [];
  }
}

function isAnnotation(value: unknown): value is ResponseAnnotation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ResponseAnnotation>;
  return typeof candidate.id === "string"
    && typeof candidate.sourceId === "string"
    && typeof candidate.quote === "string"
    && typeof candidate.comment === "string";
}

/** Session-scoped annotation drafts. They are intentionally client-side until sent. */
export function useResponseAnnotations(sessionId: string | null) {
  const [annotations, setAnnotations] = useState<ResponseAnnotation[]>(() => load(sessionId));

  useEffect(() => {
    setAnnotations(load(sessionId));
  }, [sessionId]);

  useEffect(() => {
    try {
      localStorage.setItem(keyFor(sessionId), JSON.stringify(annotations));
    } catch {
      // Draft persistence is a convenience; an unavailable browser store must not block chat.
    }
  }, [annotations, sessionId]);

  const add = useCallback((draft: Omit<ResponseAnnotation, "id" | "createdAt" | "updatedAt">) => {
    const now = new Date().toISOString();
    const annotation: ResponseAnnotation = {
      ...draft,
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: now,
      updatedAt: now,
    };
    setAnnotations((current) => [...current, annotation]);
    return annotation;
  }, []);

  const update = useCallback((id: string, changes: Pick<ResponseAnnotation, "comment">) => {
    setAnnotations((current) => current.map((annotation) =>
      annotation.id === id
        ? { ...annotation, ...changes, updatedAt: new Date().toISOString() }
        : annotation,
    ));
  }, []);

  const remove = useCallback((id: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  }, []);

  const clear = useCallback(() => setAnnotations([]), []);

  const bySource = useMemo(() => {
    const result = new Map<string, ResponseAnnotation[]>();
    annotations.forEach((annotation) => {
      const list = result.get(annotation.sourceId) ?? [];
      list.push(annotation);
      result.set(annotation.sourceId, list);
    });
    return result;
  }, [annotations]);

  return { annotations, bySource, add, update, remove, clear };
}

/** Plain, provider-agnostic context sent alongside an optional typed follow-up. */
export function formatAnnotatedFollowUp(annotations: ResponseAnnotation[], text: string) {
  const chunks = ["Please address these annotations on your previous response(s):"];
  annotations.forEach((annotation, index) => {
    chunks.push(`Annotation ${index + 1}\nQuoted text:\n“${annotation.quote}”`);
    if (annotation.contextBefore || annotation.contextAfter) {
      chunks.push(`Context:\n…${annotation.contextBefore ?? ""}${annotation.quote}${annotation.contextAfter ?? ""}…`);
    }
    chunks.push(`Comment:\n${annotation.comment.trim() || "No additional comment."}`);
  });
  if (text.trim()) chunks.push(`Additional request:\n${text.trim()}`);
  return chunks.join("\n\n");
}
