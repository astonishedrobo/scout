import { SettingsGroup, SettingsRow, SettingsSelect, Segmented, Switch } from "../ui";
import { useLocalSetting } from "../../hooks/useLocalSetting";
import { APP_VERSION } from "../../appMeta";
import type { ApprovalMode } from "scout-core";
import type { SectionProps } from "./shared";

const DEVICE_NOTE = "Remembered on this device.";

/**
 * General preferences.
 *
 * These are device-local by design rather than for want of an endpoint: they
 * describe how this browser should behave, and `POST /config` is a deployment
 * setting that is 403 in server mode anyway. Each one has a real consumer —
 * `App.tsx` reads them and acts on them; see `useLocalSetting`, whose writes
 * publish so a change here takes effect without a reload.
 *
 * Every row rendered here works. One row — "Response speed" — is deliberately
 * hidden rather than shipped inert; the commented block in the Interface group
 * below records what it was for and the backend work it is waiting on.
 */
export function GeneralSection({ isMultiUser }: SectionProps) {
  const [permissionDefault, setPermissionDefault] = useLocalSetting<ApprovalMode>(
    "general.permissionDefault",
    "ask_always",
  );
  const [suggestions, setSuggestions] = useLocalSetting("general.suggestions", true);
  const [defaultPanel, setDefaultPanel] = useLocalSetting<"none" | "files" | "tasks">(
    "general.defaultPanel",
    "none",
  );

  return (
    <>
      <SettingsGroup
        label="Permissions"
        description="What Scout may do in your workspace without asking first."
        footnote={DEVICE_NOTE}
      >
        <SettingsRow
          label="Default for new conversations"
          description="Where each conversation starts. The approval control in the composer still changes it per conversation."
          control={
            <SettingsSelect
              value={permissionDefault}
              onChange={setPermissionDefault}
              label="Default for new conversations"
              options={[
                {
                  value: "ask_always",
                  label: "Ask every time",
                  description: "Ask before workspace edits, network access, and elevated actions",
                },
                {
                  value: "allow_edits",
                  label: "Allow edits",
                  description: "Edit workspace files automatically; still ask for network access",
                },
                {
                  value: "full_access",
                  label: "Full access",
                  description: "Perform allowed edits and network actions without asking",
                },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="Interface" footnote={DEVICE_NOTE}>
        <SettingsRow
          label="Default side panel"
          description="Which panel opens with a new conversation."
          control={
            <Segmented
              value={defaultPanel}
              onChange={setDefaultPanel}
              label="Default side panel"
              options={[
                { value: "none", label: "None" },
                { value: "files", label: "Files" },
                { value: "tasks", label: "Tasks" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Suggested prompts"
          description="Show starter suggestions on the welcome screen."
          control={
            <Switch checked={suggestions} onChange={setSuggestions} label="Suggested prompts" />
          }
        />
        {/*
          Response speed — HIDDEN, not yet implemented. Do not re-enable this row
          without the server side below; a control that silently does nothing is
          worse than an absent one.

          The intent is to let the user choose how much the agent deliberates
          before answering (answer directly vs. check its own work first). That is
          a feature, not a config key: it needs a real notion of extra
          verification passes in the agent loop, so there is nothing to bind to
          yet.

          What it would take, in order:
            1. Agent side — define what "thorough" actually does. Most likely a
               verification step before the final answer, and/or a higher
               `agent.max_iterations` (see `agent` in python/src/scout/config.py).
            2. Storage — there is no per-user preference store. The precedent to
               copy is `user_memory_preferences` in python/src/scout/server/auth.py:
               a typed table with UPSERT accessors, NOT a generic key-value bag.
            3. Endpoint — `GET/PUT /agent/preferences`, mirroring the memories pair
               in python/src/scout/server/app.py, including its single-user
               fallback of writing to the global config file.
            4. Layering — apply the override in `_effective_config()` in app.py,
               which is the existing seam where a user preference beats global
               config. It currently overrides only `memories.*`.
            5. This row — swap `useLocalSetting` for the fetch/PUT pair, following
               MemoriesSection's load-and-roll-back-on-failure pattern.

          Note `POST /config` is 403 in multi-user mode, which is why this cannot
          reuse the path that ModelsSection uses; it needs its own per-user
          endpoint to work on a server deployment at all.
        */}
      </SettingsGroup>

      <SettingsGroup label="About">
        <SettingsRow label="Version" control={<span className="text-caption font-mono text-scout-muted">{APP_VERSION}</span>} />
        {!isMultiUser && (
          <>
            <SettingsRow
              label="Configuration"
              control={
                <code className="text-micro font-mono text-scout-muted">
                  ~/.config/scout/config.yaml
                </code>
              }
            />
            <SettingsRow
              label="Project overrides"
              control={<code className="text-micro font-mono text-scout-muted">.scout/config.yaml</code>}
            />
          </>
        )}
      </SettingsGroup>
    </>
  );
}
