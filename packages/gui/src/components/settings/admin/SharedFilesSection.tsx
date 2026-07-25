import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FileTypeIcon,
  IconButton,
  SettingsGroup,
  Skeleton,
  TableSearch,
  type Column,
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
  const [query, setQuery] = useState("");
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
    const chosen = Array.from(list);
    setUploading(true);
    // Each file is reported on its own. Throwing on the first failure used to
    // abandon the rest of the batch and report the whole upload as failed, even
    // though earlier files had already landed on the server.
    const uploaded: string[] = [];
    const failures: string[] = [];
    try {
      for (const file of chosen) {
        const form = new FormData();
        form.append("file", file);
        try {
          const r = await fetch(`${baseUrl}/upload?target=shared`, {
            method: "POST",
            headers: authHeaders,
            body: form,
          });
          if (!r.ok) throw new Error(await errorDetail(r, `Could not upload ${file.name}.`));
          uploaded.push(file.name);
        } catch (e) {
          failures.push(e instanceof Error ? e.message : `Could not upload ${file.name}.`);
        }
      }
      await load();
      if (failures.length === 0) {
        setStatus({
          message: `Uploaded ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}.`,
          tone: "info",
        });
      } else if (uploaded.length === 0) {
        setStatus({ message: failures[0], tone: "error" });
      } else {
        setStatus({
          message: `Uploaded ${uploaded.length} of ${chosen.length} files. ${failures[0]}`,
          tone: "error",
        });
      }
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

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  const columns: Column<SharedFile>[] = [
    {
      key: "path",
      header: "File",
      width: "minmax(140px,1fr)",
      sortValue: (f) => f.path.toLowerCase(),
      searchValue: (f) => f.path,
      render: (f) => (
        <span className="flex min-w-0 items-center gap-2">
          <FileTypeIcon name={f.path} size={14} className="shrink-0" />
          <span className="truncate font-mono text-micro" title={f.path}>
            {f.path}
          </span>
        </span>
      ),
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      width: "max-content",
      sortValue: (f) => f.size,
      render: (f) => (
        <span className="whitespace-nowrap font-mono tabular-nums text-scout-muted">
          {fmtSize(f.size)}
        </span>
      ),
    },
  ];

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
        /* The heading only. The search field and the table are two separate
           surfaces below it, so this group must not draw a container around
           both of them. */
        bare
      >
        {loading ? (
          <SettingsGroup>
            <div className="px-4 py-3">
              <Skeleton.List rows={4} />
            </div>
          </SettingsGroup>
        ) : files.length === 0 ? (
          <SettingsGroup>
            <EmptyState
              size="sm"
              icon={<Upload size={20} />}
              title="No shared files"
              body="Upload reference data every user's agent should be able to read."
            />
          </SettingsGroup>
        ) : (
          <div className="space-y-2">
            {/* Search is its own surface above the table's, not a box inside it.
                Only rendered when there is something to search. */}
            <TableSearch value={query} onChange={setQuery} placeholder="Search files" />
            <SettingsGroup>
              <div className="py-2">
                <DataTable
              columns={columns}
              rows={files}
              getRowId={(f) => f.path}
              query={query}
              initialSort={{ key: "path", dir: "asc" }}
              caption={`${files.length} file${files.length === 1 ? "" : "s"} · ${fmtSize(totalSize)} total`}
              rowActions={(file) => (
                // Was a 24px target hidden behind `hover-reveal`, so on touch it
                // was undiscoverable and on mouse it was hard to hit.
                <IconButton
                  label={`Delete ${file.path}`}
                  tone="danger"
                  onClick={() => remove(file.path)}
                >
                  <Trash2 size={15} />
                </IconButton>
              )}
                  empty={<EmptyState size="sm" title="No shared files" />}
                />
              </div>
            </SettingsGroup>
          </div>
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
