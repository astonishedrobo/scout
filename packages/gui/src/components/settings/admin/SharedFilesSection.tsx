import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  SettingsGroup,
  SettingsRow,
  Skeleton,
  type ConfirmRequest,
} from "../../ui";
import { errorDetail, useAuthHeaders, type SectionProps } from "../shared";

interface SharedFile {
  path: string;
  size: number;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files every user's agent can read. */
export function SharedFilesSection({ baseUrl, token, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl}/shared/files`, { headers: authHeaders });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not load shared files."));
      setFiles((await r.json()).files ?? []);
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not load shared files.", tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [baseUrl, authHeaders, setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append("file", file);
        const r = await fetch(`${baseUrl}/upload?target=shared`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        if (!r.ok) throw new Error(await errorDetail(r, `Could not upload ${file.name}.`));
      }
      await load();
      setStatus({ message: `Uploaded ${list.length} file${list.length > 1 ? "s" : ""}.`, tone: "info" });
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Upload failed.", tone: "error" });
    } finally {
      setUploading(false);
    }
  };

  const remove = (path: string) =>
    setConfirm({
      title: `Delete ${path}?`,
      body: "Every user's agent loses access to this file. This cannot be undone.",
      destructive: true,
      confirmLabel: "Delete",
      onConfirm: async () => {
        const r = await fetch(`${baseUrl}/shared/files?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
          headers: authHeaders,
        });
        if (!r.ok) {
          setStatus({ message: await errorDetail(r, "Could not delete file."), tone: "error" });
          return;
        }
        await load();
        setStatus({ message: `${path} deleted.`, tone: "info" });
      },
    });

  return (
    <>
      <SettingsGroup
        label="Shared files"
        description="Readable by every user's agent in this workspace."
        action={
          <Button
            variant="outlined"
            surface="panel"
            size="compact"
            loading={uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={13} />
            Upload
          </Button>
        }
      >
        {loading ? (
          <div className="px-4 py-3">
            <Skeleton.List rows={4} />
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Upload size={20} />}
            title="No shared files"
            body="Upload reference data every user's agent should be able to read."
          />
        ) : (
          files.map((file) => (
            <SettingsRow
              key={file.path}
              label={<span className="font-mono text-caption">{file.path}</span>}
              description={fmtSize(file.size)}
              control={
                // Was a 24px target hidden behind `hover-reveal`, so on touch it
                // was undiscoverable and on mouse it was hard to hit.
                <IconButton label={`Delete ${file.path}`} tone="danger" onClick={() => remove(file.path)}>
                  <Trash2 size={15} />
                </IconButton>
              }
            />
          ))
        )}
      </SettingsGroup>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
