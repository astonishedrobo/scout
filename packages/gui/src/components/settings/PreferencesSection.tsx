import { useEffect, useState } from "react";
import { Banner, Button, SettingsGroup, SettingsRow, Textarea } from "../ui";
import { useAuthHeaders, useConfigWriter, type SectionProps } from "./shared";

/**
 * Standing instructions for the agent (`agent.preferences`).
 *
 * In server mode this lives in the deployment's config.yaml and there is no
 * per-user override to write to, so it is presented read-only rather than as a
 * textarea whose save is guaranteed to 403.
 */
export function PreferencesSection(props: SectionProps) {
  const { baseUrl, token, isMultiUser } = props;
  const authHeaders = useAuthHeaders(token);
  const writeConfig = useConfigWriter(props);
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${baseUrl}/config`, { headers: authHeaders })
      .then((r) => r.json())
      .then((cfg) => {
        if (cancelled) return;
        const value: string = cfg?.agent?.preferences ?? "";
        setSaved(value);
        setDraft(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl, authHeaders]);

  const dirty = draft !== saved;

  const commit = async () => {
    setSaving(true);
    const ok = await writeConfig({ "agent.preferences": draft }, "Preferences saved.");
    if (ok) setSaved(draft);
    setSaving(false);
  };

  if (isMultiUser) {
    return (
      <>
        <Banner
          tone="info"
          variant="inline"
          messages={["Response preferences are set for this workspace by an administrator."]}
        />
        <SettingsGroup label="Response preferences">
          <SettingsRow
            label="Current instructions"
            description={saved.trim() ? undefined : "None set."}
          >
            {saved.trim() && (
              <p className="mt-2 whitespace-pre-wrap text-caption leading-relaxed text-scout-muted">
                {saved}
              </p>
            )}
          </SettingsRow>
        </SettingsGroup>
      </>
    );
  }

  return (
    <SettingsGroup
      label="Response preferences"
      description="What should Scout consider in every response?"
      action={
        <Button
          variant="ghost"
          surface="panel"
          size="compact"
          onClick={commit}
          loading={saving}
          disabled={!dirty}
        >
          Save
        </Button>
      }
    >
      <SettingsRow label="Standing instructions" description="Applies to all conversations.">
        <Textarea
          size="md"
          aria-label="Response preferences"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. prefer concise answers, use metric units, focus on statistical rigor"
          rows={4}
          className="mt-3"
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
