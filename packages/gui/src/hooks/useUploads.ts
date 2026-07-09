import { useCallback, useRef, useState } from "react";

export type UploadStatus = "uploading" | "done" | "error";

export interface UploadItem {
  id: string;
  name: string;
  status: UploadStatus;
  error?: string;
}

/** Successful upload result — enough to insert an @ reference in chat. */
export interface UploadResult {
  filename: string;
  path: string;
  abs_path: string;
  scope: "personal" | "shared" | null;
  size: number;
}

const DONE_FADE_MS = 4000;

/**
 * Owns workspace upload state and the POST logic.
 *
 * Uploads land in the user's persistent workspace (not a per-message
 * attachment), so this is decoupled from the chat input. Tracks each
 * file's progress so the UI can surface status instead of fire-and-forget.
 */
export function useUploads(baseUrl: string, token: string | null) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const counterRef = useRef(0);

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  const dismiss = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const scheduleFade = useCallback((id: string) => {
    setTimeout(() => {
      setUploads((prev) => prev.filter((u) => !(u.id === id && u.status === "done")));
    }, DONE_FADE_MS);
  }, []);

  const uploadFiles = useCallback(
    async (files: FileList | File[] | null): Promise<UploadResult[]> => {
      if (!files) return [];
      const list = Array.from(files);
      if (list.length === 0) return [];

      const succeeded: UploadResult[] = [];

      for (const file of list) {
        const id = `up_${counterRef.current++}`;
        setUploads((prev) => [...prev, { id, name: file.name, status: "uploading" }]);

        try {
          const form = new FormData();
          form.append("file", file);
          const r = await fetch(`${baseUrl}/upload?target=personal`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            body: form,
          });
          if (!r.ok) {
            let detail = `Upload failed (${r.status})`;
            try {
              const d = await r.json();
              detail = d.detail ?? detail;
            } catch {
              const t = await r.text().catch(() => "");
              if (t) detail = t;
            }
            update(id, { status: "error", error: detail });
          } else {
            const body = (await r.json()) as {
              filename?: string;
              path?: string;
              abs_path?: string;
              scope?: "personal" | "shared" | null;
              size?: number;
            };
            const filename = body.filename || file.name;
            const path = body.path || filename;
            const abs_path = body.abs_path || path;
            const scope = body.scope ?? "personal";
            succeeded.push({
              filename,
              path,
              abs_path,
              scope,
              size: body.size ?? file.size,
            });
            update(id, { status: "done" });
            scheduleFade(id);
          }
        } catch (e: any) {
          update(id, { status: "error", error: e?.message ?? "Network error" });
        }
      }

      return succeeded;
    },
    [baseUrl, token, update, scheduleFade],
  );

  const activeCount = uploads.filter((u) => u.status === "uploading").length;
  const errorCount = uploads.filter((u) => u.status === "error").length;

  return { uploads, uploadFiles, dismiss, activeCount, errorCount };
}
