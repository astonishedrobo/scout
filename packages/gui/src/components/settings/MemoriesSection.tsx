import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  SettingsGroup,
  SettingsRow,
  Skeleton,
  Switch,
  Textarea,
} from "../ui";
import { PixelBook } from "../PixelArt";
import { errorDetail, useAuthHeaders, type SectionProps } from "./shared";

export function MemoriesSection({ baseUrl, token, isMultiUser, setStatus }: SectionProps) {
  const authHeaders = useAuthHeaders(token);
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [useMemories, setUseMemories] = useState(true);
  const [generateMemories, setGenerateMemories] = useState(true);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [undoEntry, setUndoEntry] = useState<string | null>(null);

  const json = useCallback(
    async (body: unknown) => {
      const r = await fetch(`${baseUrl}/memories`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not update memories."));
      return (await r.json()) as { entries?: string[] };
    },
    [baseUrl, authHeaders],
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${baseUrl}/memories/preferences`, { headers: authHeaders })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorDetail(r, "Could not load memory preferences."));
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setUseMemories(d.use_memories ?? true);
        setGenerateMemories(d.generate_memories ?? true);
      })
      .catch((e: Error) => setStatus({ message: e.message, tone: "error" }));

    setLoading(true);
    fetch(`${baseUrl}/memories`, { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setEntries(d.entries ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [baseUrl, authHeaders, setStatus]);

  const savePreferences = async (nextUse: boolean, nextGenerate: boolean) => {
    const prev = { use: useMemories, generate: generateMemories };
    setUseMemories(nextUse);
    setGenerateMemories(nextGenerate);
    setStatus({ message: "Saving…", tone: "info" });
    try {
      const r = await fetch(`${baseUrl}/memories/preferences`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ use_memories: nextUse, generate_memories: nextGenerate }),
      });
      if (!r.ok) throw new Error(await errorDetail(r, "Could not save memory preferences."));
      setStatus({
        message: isMultiUser ? "Saved. Applies to new conversations." : "Saved.",
        tone: "info",
      });
    } catch (e) {
      // Put the switch back: leaving it flipped claims a save that did not happen.
      setUseMemories(prev.use);
      setGenerateMemories(prev.generate);
      setStatus({
        message: e instanceof Error ? e.message : "Could not save memory preferences.",
        tone: "error",
      });
    }
  };

  const add = async () => {
    if (!draft.trim()) return;
    setAdding(true);
    try {
      const d = await json({ entry: draft.trim() });
      setEntries(d.entries ?? []);
      setDraft("");
      setStatus({ message: "Memory added.", tone: "info" });
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not add memory.", tone: "error" });
    } finally {
      setAdding(false);
    }
  };

  // An undo beats a confirmation here: the common case is intentional, and the
  // text is short enough to put straight back.
  const remove = async (index: number) => {
    const removed = entries[index];
    try {
      const d = await json({ remove_index: index });
      setEntries(d.entries ?? []);
      if (removed) setUndoEntry(removed);
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not remove memory.", tone: "error" });
    }
  };

  const undo = async () => {
    if (!undoEntry) return;
    const entry = undoEntry;
    setUndoEntry(null);
    try {
      const d = await json({ entry: entry.replace(/^- /, "") });
      setEntries(d.entries ?? []);
      setStatus({ message: "Memory restored.", tone: "info" });
    } catch (e) {
      setStatus({ message: e instanceof Error ? e.message : "Could not restore memory.", tone: "error" });
    }
  };

  return (
    <>
      <SettingsGroup
        label="Memory"
        description="How Scout collects and reuses what it learns about your work."
      >
        <SettingsRow
          label="Use memories"
          description="Bring saved memories into new conversations."
          control={
            <Switch
              checked={useMemories}
              onChange={(next) => savePreferences(next, generateMemories)}
              label="Use memories"
            />
          }
        />
        <SettingsRow
          label="Generate memories"
          description="Let Scout write new memories from conversations."
          control={
            <Switch
              checked={generateMemories}
              onChange={(next) => savePreferences(useMemories, next)}
              label="Generate memories"
            />
          }
        />
      </SettingsGroup>

      {undoEntry && (
        <Banner
          tone="info"
          variant="inline"
          messages={["Memory removed."]}
          onDismiss={() => setUndoEntry(null)}
          action={
            <Button variant="ghost" surface="panel" size="compact" onClick={undo}>
              Undo
            </Button>
          }
        />
      )}

      <SettingsGroup
        label="MEMORY.md"
        description="Saved memories, in the order Scout reads them."
        action={
          <Button
            variant="ghost"
            surface="panel"
            size="compact"
            onClick={add}
            loading={adding}
            disabled={!draft.trim()}
          >
            Add
          </Button>
        }
      >
        {loading ? (
          <div className="px-4 py-3">
            <Skeleton.List rows={3} />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<PixelBook />}
            title="No memories yet"
            body="Scout writes these as it learns how you work, or you can add one below."
          />
        ) : (
          entries.map((entry, index) => (
            <SettingsRow
              key={`${index}-${entry}`}
              label={<span className="font-normal">{entry.replace(/^- /, "")}</span>}
              control={
                <IconButton label="Remove memory" tone="danger" onClick={() => remove(index)}>
                  <Trash2 size={15} />
                </IconButton>
              }
            />
          ))
        )}
        <SettingsRow label="Add a memory" description="One fact or preference per entry.">
          <Textarea
            size="md"
            aria-label="New memory"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. I work in Python and prefer polars over pandas"
            rows={2}
            className="mt-3"
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
