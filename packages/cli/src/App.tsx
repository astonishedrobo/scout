/**
 * Root component for the Scout CLI.
 *
 * Layout:
 *   ✦ Scout  v0.1.0  ● model-name          ← StatusBar
 *                                            ← Messages (Static)
 *   > user message
 *   ╭─────────────────────────────────╮
 *   │ ✓ run_code  …                  │      ← ActivityLog
 *   ╰─────────────────────────────────╯
 *   ✦ assistant response …
 *                                            ← LoadingIndicator
 *   ────────────────────────────────────     ← separator
 *   ❯ input prompt                          ← ChatInput
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { StatusBar } from "./components/StatusBar.js";
import { MessageList } from "./components/MessageList.js";
import { ChatInput } from "./components/ChatInput.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { EnvPicker } from "./components/EnvPicker.js";
import { ApprovalPrompt, type ApprovalAction } from "./components/ApprovalPrompt.js";
import { EditorPickerDialog } from "./components/EditorPickerDialog.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { WarningBanner } from "./components/WarningBanner.js";

import { useChat } from "./hooks/useChat.js";
import { useServer } from "./hooks/useServer.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";

import {
  getMergedConfig,
  setConfigValue,
  getConfiguredModels,
  hasLLMConfigured,
  ensureLLMSection,
  globalConfigPath,
  setServerConfig,
  getServerConfig,
  sendApproval,
  sendEditDone,
  reloadServerConfig,
  restoreServerSession,
  createSession,
  listSessions,
  loadSession,
  pruneOldSessions,
  SLASH_COMMANDS,
  theme,
  checkBroadDirectory,
  detectEnvs,
  type SessionMeta,
  type EnvOption,
} from "scout-core";
import { launchEditor, getPreferredEditorId } from "./editors.js";

/* ── Props ───────────────────────────────────────────────────────── */

interface AppProps {
  cwd: string;
  configPath?: string;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", ".git", ".venv", "env", ".egg-info",
]);

function walkDirShallow(root: string, depth = 0, maxDepth = 2): string[] {
  if (depth > maxDepth) return [];
  const lines: string[] = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".scout") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        lines.push(...walkDirShallow(join(root, entry.name), depth + 1, maxDepth));
      } else {
        lines.push(`${indent}${entry.name}`);
      }
      if (lines.length > 200) break;
    }
  } catch { /* permission errors */ }
  return lines;
}

/* ── Component ───────────────────────────────────────────────────── */

export const App: React.FC<AppProps> = ({ cwd, configPath }) => {
  const { exit } = useApp();
  const { columns: terminalWidth } = useTerminalSize();

  const [model, setModel] = useState<string>(
    () =>
      (getMergedConfig()?.agent?.model as string) ??
      "groq/llama-3.1-8b-instant",
  );

  // Model picker + flash error state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [modelList, setModelList] = useState<string[]>(() => getConfiguredModels());
  const [initRunning, setInitRunning] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(() => hasLLMConfigured());

  // Editor picker state + pending resume after picker closes
  const [editorPickerOpen, setEditorPickerOpen] = useState(false);
  const [pendingEditResume, setPendingEditResume] = useState<
    | { type: "init"; content: string; env: EnvOption | null }
    | { type: "agent"; approvalId: string; diffs: { path: string; status: string }[] }
    | null
  >(null);

  // Session persistence state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);

  // Env picker state for /init flow
  const [envPickerOpen, setEnvPickerOpen] = useState(false);
  const [detectedEnvs, setDetectedEnvs] = useState<EnvOption[]>([]);

  // Pending init-skill write (awaiting user approval)
  const [pendingInitWrite, setPendingInitWrite] = useState<{
    content: string;
    env: EnvOption | null;
  } | null>(null);

  // Broad directory warning (computed once at mount)
  const broadDirWarning = useMemo(() => checkBroadDirectory(cwd), [cwd]);

  // Skills status
  const skillsDir = useMemo(() => join(cwd, ".scout", "skills"), [cwd]);
  const hasSkills = useMemo(() => {
    try {
      return existsSync(skillsDir) &&
        readdirSync(skillsDir).some((f) => f.endsWith(".md"));
    } catch { return false; }
  }, [skillsDir]);

  // Auto-dismiss flash error after 5 seconds
  useEffect(() => {
    if (!flashError) return;
    const timer = setTimeout(() => setFlashError(null), 5000);
    return () => clearTimeout(timer);
  }, [flashError]);

  // Dismiss flash error on any keypress
  useInput(
    () => { setFlashError(null); },
    { isActive: !!flashError },
  );


  // Expand/collapse state for tool output
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  // ── Server lifecycle ──────────────────────────────────────────
  const serverOpts = useMemo(
    () => ({ cwd, configPath }),
    [cwd, configPath],
  );
  const { baseUrl, isReady, error: serverError, warnings: serverWarnings } = useServer(serverOpts);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  // Dismiss warning banner on Esc
  useInput(
    (_input, key) => {
      if (key.escape) setWarningsDismissed(true);
    },
    { isActive: !warningsDismissed && serverWarnings.length > 0 },
  );

  // Sync model name from server once ready; model list comes from local config
  useEffect(() => {
    if (!isReady || !baseUrl) return;
    getServerConfig(baseUrl)
      .then((cfg) => {
        const agent = cfg?.agent as Record<string, unknown> | undefined;
        const m = agent?.model as string;
        if (m) setModel(m);
      })
      .catch(() => {});
    // Refresh model list from local config
    const models = getConfiguredModels();
    setModelList(models);
    setLlmConfigured(models.length > 0);
  }, [isReady, baseUrl]);

  // ── Chat state ────────────────────────────────────────────────
  const {
    messages,
    setMessages,
    streamingSteps,
    currentTool,
    isLoading,
    error: chatError,
    pendingApproval,
    clearApproval,
    sendMessage,
    reset,
  } = useChat({
    baseUrl: baseUrl ?? "http://127.0.0.1:7890",
    cwd,
    sessionId,
    model,
  });

  // ── Expand/collapse toggle ────────────────────────────────────
  const handleToggleExpand = useCallback((index: number) => {
    setExpandedIndex((prev) => (prev === index ? null : index));
  }, []);

  // Tab toggles the most recent assistant message's tool steps
  useInput(
    (_input, key) => {
      if (!key.tab) return;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].steps && messages[i].steps!.length > 0) {
          handleToggleExpand(i);
          break;
        }
      }
    },
    { isActive: !isLoading && isReady },
  );

  // ── Slash command handler ─────────────────────────────────────
  const handleSubmit = useCallback(
    async (text: string) => {
      if (text.startsWith("/")) {
        const parts = text.split(/\s+/);
        const cmd = parts[0]!.toLowerCase();

        switch (cmd) {
          case "/quit":
          case "/exit":
            exit();
            return;

          case "/reset": {
            await reset();
            setExpandedIndex(null);
            // Start a fresh session
            try {
              const newId = createSession(cwd, model);
              setSessionId(newId);
            } catch { /* best-effort */ }
            return;
          }

          case "/resume":
          case "/sessions": {
            const sessions = listSessions(cwd);
            if (sessions.length === 0) {
              setFlashError("No previous sessions found for this project.");
              return;
            }
            setSessionList(sessions);
            setSessionPickerOpen(true);
            return;
          }

          case "/init": {
            if (hasSkills) {
              setFlashError(
                `Skills already exist at .scout/skills/ — edit them directly.`,
              );
              return;
            }
            if (!baseUrl || !isReady) {
              setFlashError("Server not ready yet — try again in a moment.");
              return;
            }
            const envs = detectEnvs(cwd);
            if (envs.length > 1) {
              setDetectedEnvs(envs);
              setEnvPickerOpen(true);
            } else {
              runInit(null);
            }
            return;
          }

          case "/editor":
            setEditorPickerOpen(true);
            return;

          case "/model": {
            // Always refresh from disk — config may have been edited externally
            const freshModels = getConfiguredModels();
            setModelList(freshModels);
            setLlmConfigured(freshModels.length > 0);

            if (freshModels.length === 0) {
              setFlashError("No models configured. Run /config llm to add providers and models.");
              return;
            }
            if (parts[1]) {
              const newModel = parts[1];
              if (!freshModels.includes(newModel)) {
                setFlashError(
                  `Unknown model "${newModel}". Use /model to pick from configured models.`,
                );
                return;
              }
              if (newModel === model) return;
              setConfigValue("agent.model", newModel, "global");
              if (baseUrl) {
                await setServerConfig(baseUrl, "agent.model", newModel, "global");
                await reloadServerConfig(baseUrl);
              }
              setModel(newModel);
            } else {
              setModelPickerOpen(true);
            }
            return;
          }

          case "/config": {
            const section = parts[1]?.replace(/^--/, "");
            if (section === "llm" || section === "agent" || !section) {
              ensureLLMSection();
              const configFile = globalConfigPath();
              try {
                await launchEditor([configFile]);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setFlashError(`Editor failed: ${msg}`);
                return;
              }
              // Reload config after editor closes
              const models = getConfiguredModels();
              setModelList(models);
              const nowConfigured = models.length > 0;
              setLlmConfigured(nowConfigured);
              if (nowConfigured && baseUrl) {
                await reloadServerConfig(baseUrl);
                const cfg = getMergedConfig();
                const m = cfg?.agent?.model as string | undefined;
                if (m) setModel(m);
              }
            } else {
              setFlashError("Usage: /config, /config llm, or /config agent");
            }
            return;
          }

          case "/help":
            console.log(
              [
                "",
                "Commands:",
                ...SLASH_COMMANDS.map(
                  (c) => `  ${c.name.padEnd(12)} ${c.description}`,
                ),
                "",
                "Tips:",
                "  @path/to/file   Attach a file for analysis",
                "  Tab             Toggle expand/collapse tool output",
                "",
              ].join("\n"),
            );
            return;

          default:
            console.log(`Unknown command: ${cmd}. Type /help for commands.`);
            return;
        }
      }

      if (!isReady || !llmConfigured) return;

      // Lazily create session on first real user message
      let sid = sessionId;
      if (!sid) {
        try {
          sid = createSession(cwd, model);
          setSessionId(sid);
          pruneOldSessions(cwd);
        } catch { /* best-effort */ }
      }
      await sendMessage(text, sid ?? undefined);
    },
    [isReady, baseUrl, sendMessage, reset, exit, modelList, cwd, hasSkills, skillsDir, model, llmConfigured, sessionId],
  );

  // ── /init skill generation (called after env selection or skip) ──

  /** Build the full skill content including env section. */
  const buildSkillContent = useCallback(
    (rawContent: string, selectedEnv: EnvOption | null): string => {
      let full = rawContent;
      if (selectedEnv && selectedEnv.type !== "system") {
        full += `\n\n## Python Environment\n\n`;
        full += `- **Type:** ${selectedEnv.type}\n`;
        full += `- **Name:** ${selectedEnv.value}\n`;
        full += `- **Note:** User prefers this environment for code execution. Use packages available here.\n`;
      }
      return full;
    },
    [],
  );

  /** Generate skill content from the LLM, then ask for approval. */
  const runInit = useCallback(
    async (selectedEnv: EnvOption | null, extraHint?: string) => {
      if (!baseUrl || !isReady) return;
      setInitRunning(true);
      try {
        let listing = walkDirShallow(cwd).join("\n");
        if (extraHint) {
          listing += `\n\n[User feedback on previous draft: ${extraHint}]`;
        }
        const resp = await fetch(`${baseUrl}/init-skill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directory_summary: listing }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          setFlashError(`Skill generation failed: ${body.slice(0, 200)}`);
          return;
        }
        const { content } = (await resp.json()) as { content: string };
        const fullContent = buildSkillContent(content, selectedEnv);

        // Show approval prompt instead of writing directly
        setPendingInitWrite({ content: fullContent, env: selectedEnv });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFlashError(`Init failed: ${msg}`);
      } finally {
        setInitRunning(false);
      }
    },
    [baseUrl, isReady, cwd, buildSkillContent],
  );

  /** Commit the approved init-skill content to disk. */
  const commitInitWrite = useCallback(
    async (content: string, selectedEnv: EnvOption | null) => {
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, "workspace.md"), content, "utf-8");

      if (selectedEnv && selectedEnv.type === "conda") {
        setConfigValue("agent.conda_env", selectedEnv.value, "global");
        if (baseUrl) {
          await setServerConfig(baseUrl, "agent.conda_env", selectedEnv.value, "global");
        }
      } else if (selectedEnv && selectedEnv.type === "venv") {
        setConfigValue("agent.python_path", selectedEnv.value, "global");
        if (baseUrl) {
          await setServerConfig(baseUrl, "agent.python_path", selectedEnv.value, "global");
        }
      }

      setFlashError(null);
      console.log(`\n  ✓ Generated .scout/skills/workspace.md\n`);
    },
    [baseUrl, skillsDir],
  );

  /** Handle user's response to the init-skill approval prompt. */
  const handleInitApproval = useCallback(
    async (action: ApprovalAction, feedback?: string) => {
      if (!pendingInitWrite) return;
      const { content, env } = pendingInitWrite;

      if (action === "yes" || action === "always") {
        setPendingInitWrite(null);
        await commitInitWrite(content, env);
      } else if (action === "suggest" && feedback) {
        setPendingInitWrite(null);
        await runInit(env, feedback);
      } else if (action === "edit") {
        const prefId = getPreferredEditorId();
        if (!prefId) {
          // No editor configured — show picker, resume edit after selection
          setPendingEditResume({ type: "init", content, env });
          setPendingInitWrite(null);
          setEditorPickerOpen(true);
          return;
        }
        setPendingInitWrite(null);
        const filePath = join(skillsDir, "workspace.md");
        mkdirSync(skillsDir, { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        try {
          await launchEditor([filePath]);
          const edited = readFileSync(filePath, "utf-8");
          await commitInitWrite(edited, env);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setFlashError(`Editor failed: ${msg}`);
        }
      } else {
        // "no" → discard
        setPendingInitWrite(null);
      }
    },
    [pendingInitWrite, commitInitWrite, runInit, skillsDir],
  );

  // Env picker callbacks
  const handleEnvSelect = useCallback(
    (env: EnvOption) => {
      setEnvPickerOpen(false);
      runInit(env);
    },
    [runInit],
  );

  const handleEnvCancel = useCallback(() => {
    setEnvPickerOpen(false);
    runInit(null);
  }, [runInit]);

  // Approval prompt callback
  const handleApprovalRespond = useCallback(
    async (action: ApprovalAction, feedback?: string) => {
      if (!pendingApproval || !baseUrl) return;

      if (action === "edit") {
        const prefId = getPreferredEditorId();
        if (!prefId) {
          // No editor configured — show picker, resume edit after selection
          const { approvalId, diffs } = pendingApproval;
          setPendingEditResume({
            type: "agent",
            approvalId,
            diffs: diffs.map((d) => ({ path: d.path, status: d.status })),
          });
          setEditorPickerOpen(true);
          return;
        }
        // Capture data before clearing state
        const { approvalId, diffs } = pendingApproval;
        const filePaths = diffs
          .filter((d) => d.status !== "deleted")
          .map((d) => join(cwd, d.path));

        await sendApproval(baseUrl, approvalId, "edit");
        clearApproval();

        try {
          await launchEditor(filePaths);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setFlashError(`Editor failed: ${msg}`);
        }
        await sendEditDone(baseUrl, approvalId);
        return;
      }

      await sendApproval(baseUrl, pendingApproval.approvalId, action, feedback ?? "");
      clearApproval();
    },
    [pendingApproval, baseUrl, clearApproval, cwd],
  );

  // Editor picker close — resume pending edit if an editor was selected
  const handleEditorPickerClose = useCallback(
    async (selectedId: string | null) => {
      setEditorPickerOpen(false);
      const resume = pendingEditResume;
      setPendingEditResume(null);

      if (!selectedId || !resume) return;

      if (resume.type === "init") {
        const filePath = join(skillsDir, "workspace.md");
        mkdirSync(skillsDir, { recursive: true });
        writeFileSync(filePath, resume.content, "utf-8");
        try {
          await launchEditor([filePath]);
          const edited = readFileSync(filePath, "utf-8");
          await commitInitWrite(edited, resume.env);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setFlashError(`Editor failed: ${msg}`);
        }
      } else if (resume.type === "agent" && baseUrl) {
        const filePaths = resume.diffs
          .filter((d) => d.status !== "deleted")
          .map((d) => join(cwd, d.path));

        await sendApproval(baseUrl, resume.approvalId, "edit");
        clearApproval();

        try {
          await launchEditor(filePaths);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setFlashError(`Editor failed: ${msg}`);
        }
        await sendEditDone(baseUrl, resume.approvalId);
      }
    },
    [pendingEditResume, skillsDir, baseUrl, clearApproval, cwd, commitInitWrite],
  );

  // Session picker callbacks
  const handleSessionSelect = useCallback(
    async (session: SessionMeta) => {
      setSessionPickerOpen(false);
      try {
        const { meta, messages: restored } = loadSession(cwd, session.sessionId);
        setSessionId(session.sessionId);
        setMessages(restored);
        setExpandedIndex(null);

        // Restore server-side agent context
        if (baseUrl) {
          const simple = restored.map((m) => ({
            role: m.role,
            content: m.content,
          }));
          await restoreServerSession(baseUrl, simple);
        }

        console.log(
          `\n  ✓ Resumed session: ${meta.title} (${meta.messageCount} messages)\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFlashError(`Failed to resume session: ${msg}`);
      }
    },
    [cwd, baseUrl, setMessages],
  );

  const handleSessionCancel = useCallback(() => {
    setSessionPickerOpen(false);
  }, []);

  // Model picker callbacks
  const handleModelSelect = useCallback(
    async (newModel: string) => {
      setModelPickerOpen(false);
      setConfigValue("agent.model", newModel, "global");
      if (baseUrl) {
        await setServerConfig(baseUrl, "agent.model", newModel, "global");
      }
      setModel(newModel);
    },
    [baseUrl],
  );

  const handleModelCancel = useCallback(() => {
    setModelPickerOpen(false);
  }, []);

  const displayError = serverError || chatError;

  /* ── Layout ──────────────────────────────────────────────────── */
  return (
    <Box flexDirection="column" width={terminalWidth}>
      {/* ── Header ───────────────────────────────────────── */}
      <StatusBar model={model} connected={isReady} />

      {/* ── Broad directory warning ──────────────────────── */}
      {broadDirWarning && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color="yellow" italic>
            ⚠ {broadDirWarning}
          </Text>
        </Box>
      )}

      {/* ── Startup / error banners ──────────────────────── */}
      {!isReady && !serverError && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.status.active} italic>
            Starting server…
          </Text>
        </Box>
      )}
      {displayError && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.status.error}>⚠ {displayError}</Text>
        </Box>
      )}
      {flashError && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.status.error}>
            ⚠ {flashError}
          </Text>
        </Box>
      )}

      {/* ── First-run gate: no LLM configured ─────────────── */}
      {isReady && !llmConfigured && (
        <Box paddingLeft={2} marginBottom={1} flexDirection="column">
          <Text color={theme.status.warning} bold>
            No LLM provider configured.
          </Text>
          <Text color={theme.text.secondary}>
            Run <Text color={theme.text.accent} bold>/config llm</Text> to set up your API key and models.
          </Text>
        </Box>
      )}

      {/* ── Skills status banner ─────────────────────────── */}
      {isReady && llmConfigured && !hasSkills && !broadDirWarning && messages.length === 0 && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.text.secondary} italic>
            Tip: Run /init to generate workspace skills for this directory
          </Text>
        </Box>
      )}

      {/* ── Init running indicator ───────────────────────── */}
      {initRunning && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.status.active} italic>
            Generating workspace skills…
          </Text>
        </Box>
      )}

      {/* ── Conversation + streaming indicator ────────────── */}
      <Box flexDirection="column" flexGrow={1}>
        <MessageList
          messages={messages}
          streamingSteps={streamingSteps}
          isLoading={isLoading}
          currentTool={currentTool}
          expandedIndex={expandedIndex}
          width={terminalWidth}
        />
      </Box>

      {/* ── Model picker overlay ──────────────────────────── */}
      {modelPickerOpen && (
        <ModelPicker
          models={modelList}
          currentModel={model}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
        />
      )}

      {/* ── Session picker overlay ────────────────────────── */}
      {sessionPickerOpen && (
        <SessionPicker
          sessions={sessionList}
          onSelect={handleSessionSelect}
          onCancel={handleSessionCancel}
        />
      )}

      {/* ── Editor picker overlay ─────────────────────────── */}
      {editorPickerOpen && (
        <EditorPickerDialog onClose={handleEditorPickerClose} />
      )}

      {/* ── Env picker overlay ───────────────────────────── */}
      {envPickerOpen && (
        <EnvPicker
          envs={detectedEnvs}
          onSelect={handleEnvSelect}
          onCancel={handleEnvCancel}
        />
      )}

      {/* ── Write-approval overlay (agent writes) ──────────── */}
      {pendingApproval && (
        <ApprovalPrompt
          request={pendingApproval}
          onRespond={handleApprovalRespond}
        />
      )}

      {/* ── Init-skill approval overlay ──────────────────── */}
      {pendingInitWrite && (
        <ApprovalPrompt
          request={{
            approvalId: "init-skill",
            toolName: "/init",
            diffs: [{
              path: ".scout/skills/workspace.md",
              status: "added",
              diff: pendingInitWrite.content
                .split("\n")
                .map((l) => `+${l}`)
                .slice(0, 30)
                .join("\n"),
            }],
          }}
          onRespond={handleInitApproval}
        />
      )}

      {/* ── Warning banner (pinned above input) ────────────── */}
      {!warningsDismissed && serverWarnings.length > 0 && (
        <WarningBanner
          warnings={serverWarnings}
          width={terminalWidth}
        />
      )}

      {/* ── Input (Composer) ─────────────────────────────── */}
      <ChatInput
        onSubmit={handleSubmit}
        disabled={isLoading || !isReady || modelPickerOpen || sessionPickerOpen || editorPickerOpen || envPickerOpen || initRunning || !!pendingApproval || !!pendingInitWrite}
        cwd={cwd}
        width={terminalWidth}
      />
    </Box>
  );
};
