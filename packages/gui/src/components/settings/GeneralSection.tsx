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
 * "Response speed" is the exception and is still inert: making it real means
 * deciding how much the agent deliberates before answering, which is a feature,
 * not a config key.
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
  const [speed, setSpeed] = useLocalSetting<"standard" | "thorough">("general.speed", "standard");

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
        <SettingsRow
          label="Response speed"
          description="How much work Scout does before answering. Not in effect yet."
          control={
            <SettingsSelect
              value={speed}
              onChange={setSpeed}
              label="Response speed"
              options={[
                { value: "standard", label: "Standard", description: "Answer as soon as it can" },
                { value: "thorough", label: "Thorough", description: "Check its work first" },
              ]}
            />
          }
        />
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
