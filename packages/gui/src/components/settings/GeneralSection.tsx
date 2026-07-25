import { SettingsGroup, SettingsRow, SettingsSelect, Segmented, Switch } from "../ui";
import { useLocalSetting } from "../../hooks/useLocalSetting";
import { APP_VERSION } from "../../appMeta";
import type { SectionProps } from "./shared";

const DEVICE_NOTE = "Saved on this device until the server setting lands.";

/**
 * General preferences.
 *
 * Every row here is device-local: none of these have an endpoint yet. They are
 * built now so the layout is final and the behaviour is real to click through;
 * see `useLocalSetting` for the seam that swaps in a server call later.
 */
export function GeneralSection({ isMultiUser }: SectionProps) {
  const [askBeforeRun, setAskBeforeRun] = useLocalSetting("general.askBeforeRun", true);
  const [autoReview, setAutoReview] = useLocalSetting("general.autoReview", true);
  const [fullAccess, setFullAccess] = useLocalSetting("general.fullAccess", false);
  const [suggestions, setSuggestions] = useLocalSetting("general.suggestions", true);
  const [defaultPanel, setDefaultPanel] = useLocalSetting<"files" | "tasks">(
    "general.defaultPanel",
    "files",
  );
  const [speed, setSpeed] = useLocalSetting<"standard" | "thorough">("general.speed", "standard");
  const [preventSleep, setPreventSleep] = useLocalSetting("general.preventSleep", false);
  const isDesktop = !!window.scoutDesktop;

  return (
    <>
      <SettingsGroup
        label="Permissions"
        description="What Scout may do in your workspace without asking first."
        footnote={DEVICE_NOTE}
      >
        <SettingsRow
          label="Ask before running commands"
          description="Approve each shell command and file write before it runs."
          control={
            <Switch
              checked={askBeforeRun}
              onChange={setAskBeforeRun}
              label="Ask before running commands"
            />
          }
        />
        <SettingsRow
          label="Auto-review file changes"
          description="Open the diff automatically when Scout edits a file."
          control={
            <Switch checked={autoReview} onChange={setAutoReview} label="Auto-review file changes" />
          }
        />
        <SettingsRow
          label="Full workspace access"
          description="Skip approval for reads and writes anywhere in the workspace. Raises the risk of unintended changes."
          control={
            <Switch checked={fullAccess} onChange={setFullAccess} label="Full workspace access" />
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
          description="How much work Scout does before answering."
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
        {isDesktop && (
          <SettingsRow
            label="Prevent sleep while running"
            description="Keep this machine awake until the task finishes."
            control={
              <Switch
                checked={preventSleep}
                onChange={setPreventSleep}
                label="Prevent sleep while running"
              />
            }
          />
        )}
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
