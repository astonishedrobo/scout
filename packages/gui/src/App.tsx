import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Bot, FolderTree, GitCompareArrows } from "lucide-react";
import { useServer } from "./hooks/useServer";
import { useChat } from "./hooks/useChat";
import { useConfig } from "./hooks/useConfig";
import { useTheme } from "./hooks/useTheme";
import { useSessions } from "./hooks/useSessions";
import { usePanelPrefs } from "./hooks/usePanelPrefs";
import { useRightPanelTabs } from "./hooks/useRightPanelTabs";
import { useShortcuts } from "./hooks/useShortcuts";
import { useSubagents } from "./hooks/useSubagents";
import type { ToolStep, Artifact, ChatImage, FileChangeSet, ResponseAnnotation, TaskEvent, ApprovalMode } from "scout-core";
import { useLocalSetting } from "./hooks/useLocalSetting";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { BootScreen } from "./components/BootScreen";
import { ServerErrorScreen } from "./components/ServerErrorScreen";
import { Sidebar } from "./components/Sidebar";
import { ChatView, WelcomeContent, SuggestionChips } from "./components/ChatView";
import { InputBar } from "./components/InputBar";
import { PixelPet } from "./components/PixelPet";
import { WelcomeScene } from "./components/WelcomeScene";
import { ApprovalDock } from "./components/ApprovalDock";
import { SettingsSurface, type SettingsSectionId } from "./components/SettingsSurface";
import { InitWizard } from "./components/InitWizard";
import { HelpDialog } from "./components/HelpDialog";
import { ErrorBanner, WarningBanner } from "./components/ui/Banner";
import { useAuth } from "./hooks/useAuth";
import { useUploads } from "./hooks/useUploads";
import { Login } from "./components/Login";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { UserInputCard } from "./components/UserInputCard";
import { FileChangePanel } from "./components/FileChangePanel";
import { FileExplorerPanel } from "./components/FileExplorerPanel";
import { RightPanel } from "./components/RightPanel";
import type { LauncherItem } from "./components/PanelLauncher";
import {
  AgentsPanel,
  SubagentStatusStrip,
} from "./components/AgentsPanel";
import { useApprovalMode } from "./hooks/useApprovalMode";
import { useResponseAnnotations } from "./hooks/useResponseAnnotations";

/** Sections whose canonical URL is `/admin` rather than `/settings`. */
const ADMIN_SECTIONS = new Set<SettingsSectionId>([
  "files",
  "users",
  "execution",
  "executions",
  "mcp",
  "config",
]);

/** Allow-list for the `?tab=` deep link, across both route bases. */
const SETTINGS_SECTION_IDS = new Set<string>([
  "general",
  "appearance",
  "preferences",
  "memories",
  "shortcuts",
  "connections",
  "models",
  ...ADMIN_SECTIONS,
]);

export function App() {
  const { baseUrl, isReady, isMultiUser, error: serverError, warnings: serverWarnings } = useServer();
  const { token, user, login, register, logout, authError } = useAuth(baseUrl);

  const {
    sessions,
    sessionsLoading,
    currentSessionId,
    createSession,
    loadSession,
    renameSession,
    deleteSession,
    appendMessage,
    setCurrentSessionId,
    forkSession,
    refreshSessions,
  } = useSessions(baseUrl, isReady, token, isMultiUser, logout);

  const sessionRef = useRef<string | null>(null);
  sessionRef.current = currentSessionId;
  const initialSyncRef = useRef(false);
  // True until the initial route (deep-linked session or home) is resolved.
  const [routeBooting, setRouteBooting] = useState(true);

  /*
   * Device-local settings from Appearance / General, read here rather than in the
   * leaf components so there is one consumer per setting and the wiring is
   * visible. `useLocalSetting` publishes on write, so these take effect without a
   * reload. Declared above the draft approval state because the configured
   * permission is what a fresh composer starts from.
   */
  const [showSuggestions] = useLocalSetting("general.suggestions", true);
  // Defaults to "none" so switching this on is an opt-in: a stored default of
  // "files" would have started opening the panel for everyone the moment the
  // setting became functional.
  const [defaultPanel] = useLocalSetting<"none" | "files" | "tasks">(
    "general.defaultPanel",
    "none",
  );
  const [permissionDefault] = useLocalSetting<ApprovalMode>(
    "general.permissionDefault",
    "ask_always",
  );

  const {
    mode: approvalMode,
    setMode: setApprovalMode,
    resetToDefault: resetApprovalMode,
    isChanging: approvalModeChanging,
    error: approvalModeError,
  } = useApprovalMode({
    baseUrl,
    sessionId: currentSessionId,
    token,
    isReady,
    defaultMode: permissionDefault,
  });

  const ensureSession = useCallback(async (initialMode: ApprovalMode): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = await createSession(undefined, initialMode);
    sessionRef.current = id;
    // Creation persists this mode atomically before useApprovalMode can load
    // the new session, so the composer's first GET cannot race a follow-up PUT.
    window.location.hash = `/c/${id}`;
    return id;
  }, [createSession]);

  const ensureComposerSession = useCallback(
    () => ensureSession(approvalMode),
    [approvalMode, ensureSession],
  );

  const onUserMessage = useCallback(
    async () => ensureComposerSession(),
    [ensureComposerSession],
  );

  const onUserAccepted = useCallback(
    async (sessionId: string, text: string, attachments: string[] = [], chatImages: ChatImage[] = [], annotations: ResponseAnnotation[] = []) => {
      await appendMessage(sessionId, "user", text, { attachments, chat_images: chatImages, annotations });
    },
    [appendMessage],
  );

  const onAssistantMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      steps: ToolStep[],
      artifacts: Artifact[],
      fileChanges: FileChangeSet[],
      extra?: { stopped?: boolean },
    ) => {
      await appendMessage(sessionId, "assistant", content, {
        steps,
        artifacts,
        file_changes: fileChanges,
        ...(extra?.stopped ? { stopped: true } : {}),
      });
    },
    [appendMessage],
  );

  const onSessionTitle = useCallback(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const {
    messages,
    setMessages,
    setMessagesForSession,
    streamingSteps,
    currentTool,
    streamingText,
    statusMessage,
    activityStartedAt,
    isLoading,
    error: chatError,
    pendingApproval,
    pendingUserInput,
    clearApproval,
    receiveApproval,
    clearUserInput,
    isSessionLoading,
    clearSession,
    sendMessage,
    sendSteer,
    activateSteer,
    cancelSteer,
    receiveSteerEvent,
    beginExternalTurn,
    receiveExternalTurnEvent,
    commitExternalTurn,
    finishExternalTurn,
    pendingSteers,
    stop,
    retryAt,
    reset,
  } = useChat({
    baseUrl,
    sessionId: currentSessionId || "default",
    token,
    onUserMessage,
    onUserAccepted,
    onAssistantMessage,
    onSessionTitle,
  });

  const { models, currentModel, setModel, reloadConfig, capabilities } = useConfig(baseUrl, isReady, token);
  const { theme, toggle: toggleTheme } = useTheme();
  const {
    annotations,
    add: addAnnotation,
    update: updateAnnotation,
    remove: removeAnnotation,
    clear: clearAnnotations,
  } = useResponseAnnotations(currentSessionId);
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    artifactDefaultSize,
    setArtifactDefaultSize,
  } = usePanelPrefs();

  const isAdmin = !!user?.is_admin;
  // Settings and Admin are one surface now, so one open flag and one section.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [initOpen, setInitOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const panel = useRightPanelTabs();
  // Visibility is deliberately independent from tab lifecycle. Hiding the
  // panel must not destroy the file tree, selected preview, tab set, or scroll
  // positions; only an explicit tab close should discard a surface.
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [isAutoContinuing, setIsAutoContinuing] = useState(false);
  const [autoStreamingText, setAutoStreamingText] = useState("");
  const [autoContinueStartedAt, setAutoContinueStartedAt] = useState<number | null>(null);

  const chatRoute = useCallback(() => sessionRef.current ? `/#/c/${sessionRef.current}` : "/#/", []);
  // `/settings` and `/admin` both open the same surface; the base keeps matching
  // the section so existing links and bookmarks still resolve.
  const settingsUrl = useCallback(
    (section: SettingsSectionId) =>
      `${ADMIN_SECTIONS.has(section) ? "/admin" : "/settings"}?tab=${encodeURIComponent(section)}`,
    [],
  );
  const openSettingsRoute = useCallback(
    (section: SettingsSectionId = "general") => {
      setSettingsSection(section);
      setSettingsOpen(true);
      window.history.pushState({}, "", settingsUrl(section));
    },
    [settingsUrl],
  );
  const openAdminRoute = useCallback(
    (section: SettingsSectionId = "files") => openSettingsRoute(section),
    [openSettingsRoute],
  );
  const closeSettingsRoute = useCallback(() => {
    setSettingsOpen(false);
    setSettingsSection("general");
    window.history.pushState({}, "", chatRoute());
  }, [chatRoute]);

  const openMemories = useCallback(() => {
    openSettingsRoute("memories");
  }, [openSettingsRoute]);

  /**
   * The right panel holds several tabs at once. These keep the old signatures so
   * every call site downstream is unchanged; what changed is that opening one
   * surface no longer destroys the others.
   */
  const openArtifact = useCallback(
    (artifact: Artifact) => {
      panel.open({ kind: "artifact", artifact });
      setRightPanelOpen(true);
    },
    [panel],
  );

  const openFileChanges = useCallback(
    (changeSet: FileChangeSet) => {
      panel.open({ kind: "review", changeSet });
      setRightPanelOpen(true);
    },
    [panel],
  );

  const openFilesExplorer = useCallback(() => {
    panel.open({ kind: "files" });
    setRightPanelOpen(true);
  }, [panel]);

  const openAgentsPanel = useCallback(() => {
    panel.open({ kind: "agents" });
    setRightPanelOpen(true);
  }, [panel]);


  const filesTabActive = panel.active?.tab.kind === "files";
  const agentsTabActive = panel.active?.tab.kind === "agents";

  const {
    active: activeSubagents,
    done: doneSubagents,
    selectedId: selectedSubagentId,
    detail: subagentDetail,
    selectAgent,
    clearSelection: clearSubagentSelection,
    sendMessage: sendSubagentMessage,
    stopAgent: stopSubagent,
  } = useSubagents({
    baseUrl,
    sessionId: currentSessionId,
    token,
    enabled: isReady && !!currentSessionId,
    onApprovalEvent: (event) => {
      if (event?.type === "approval_request") {
        receiveApproval(event, currentSessionId || "default");
      } else if (event?.type === "approval_cancelled") {
        clearApproval();
      }
    },
    onSteerEvent: (event) => {
      void receiveSteerEvent(event as Parameters<typeof receiveSteerEvent>[0], currentSessionId || "default");
    },
    // Background completions are queued by the server and integrated by one
    // normal supervisor turn; stream that durable reply into the transcript.
    onParentAutoReply: (content) => {
      commitExternalTurn(content, currentSessionId || "default");
      setIsAutoContinuing(false);
      setAutoStreamingText("");
      setAutoContinueStartedAt(null);
    },
    onParentAutoEvent: (event) => {
      receiveExternalTurnEvent(event, currentSessionId || "default");
    },
    onParentAutoResponseStart: () => setAutoStreamingText(""),
    onParentAutoResponseDelta: (content) => {
      setAutoStreamingText((current) => current + content);
    },
    onParentAutoTurnStarted: (event) => {
      beginExternalTurn(String(event.turn_id || ""), currentSessionId || "default");
      setAutoStreamingText("");
      setAutoContinueStartedAt(Date.now());
      setIsAutoContinuing(true);
    },
    onParentAutoTurnFinished: () => {
      finishExternalTurn(currentSessionId || "default");
      setAutoStreamingText("");
      setAutoContinueStartedAt(null);
      setIsAutoContinuing(false);
    },
    onTaskEvent: (task: TaskEvent) => {
      setMessages((previous) => {
        const index = previous.findIndex(
          (message) => message.role === "system" && message.task?.task_id === task.task_id,
        );
        const row = { role: "system" as const, content: "", task };
        if (index < 0) return [...previous, row];
        const next = [...previous];
        next[index] = row;
        return next;
      });
    },
  });
  const chatBusy = isLoading || isAutoContinuing;
  const terminalTasks = messages
    .filter((message) => message.role === "system" && message.task?.task_type === "terminal")
    .map((message) => message.task!);

  /** Hide the panel without destroying any of its mounted surface state. */
  const hidePanel = useCallback(() => {
    setRightPanelOpen(false);
  }, []);

  /** The most recent change set in the transcript — what "Review" opens. */
  const latestChangeSet = useMemo(
    () =>
      [...messages].reverse().flatMap((m) => m.fileChanges ?? [])[0] as
        | FileChangeSet
        | undefined,
    [messages],
  );

  const launcherItems = useMemo<LauncherItem[]>(
    () => [
      {
        id: "review",
        label: "Review",
        icon: <GitCompareArrows size={15} />,
        shortcut: "panel.review",
        disabled: !latestChangeSet,
        hint: "No changes yet",
        onSelect: () => {
          if (latestChangeSet) openFileChanges(latestChangeSet);
        },
      },
      {
        id: "files",
        label: "Files",
        icon: <FolderTree size={15} />,
        shortcut: "panel.files",
        onSelect: openFilesExplorer,
      },
      {
        id: "agents",
        label: "Agents",
        icon: <Bot size={15} />,
        shortcut: "panel.agents",
        badge:
          activeSubagents.length > 0 ? (
            <span className="shrink-0 text-micro font-semibold text-scout-accent-cta">
              {activeSubagents.length}
            </span>
          ) : undefined,
        onSelect: openAgentsPanel,
      },
    ],
    [activeSubagents.length, latestChangeSet, openAgentsPanel, openFileChanges, openFilesExplorer],
  );

  const [rightPanelExpanded, setRightPanelExpanded] = useState(false);
  const toggleRightPanelExpanded = useCallback(() => setRightPanelExpanded((value) => !value), []);
  useShortcuts({
    "panel.files": openFilesExplorer,
    "panel.agents": openAgentsPanel,
    "panel.review": () => {
      if (latestChangeSet) openFileChanges(latestChangeSet);
    },
    // Restore the exact surface that was visible before the panel was hidden.
    // With no tabs, the already-mounted panel naturally shows its launcher.
    "panel.toggle": () => {
      setRightPanelOpen((open) => !open);
    },
    "panel.closeTab": () => {
      if (rightPanelOpen && panel.activeKey) panel.close(panel.activeKey);
    },
  });

  // Keep open tabs current as the stream produces newer versions of what they
  // show. `replace` rather than `open`, so refreshing a background tab does not
  // yank the panel away from the one you are reading.
  useEffect(() => {
    for (const open of panel.tabs) {
      if (open.tab.kind === "artifact") {
        const current = open.tab.artifact;
        const latest = [...messages]
          .reverse()
          .flatMap((m) => m.artifacts ?? [])
          .find((artifact) => artifact.path === current.path);
        if (latest && latest.version !== current.version) {
          panel.replace({ kind: "artifact", artifact: latest });
        }
      } else if (open.tab.kind === "review") {
        const current = open.tab.changeSet;
        const latest = [...messages]
          .reverse()
          .flatMap((m) => m.fileChanges ?? [])
          .find((changeSet) => changeSet.id === current.id);
        if (latest && latest !== current) panel.replace({ kind: "review", changeSet: latest });
      }
    }
  }, [messages, panel]);

  const markChangeSetUndone = useCallback((changeSetId: string) => {
    setMessages((prev) => prev.map((message) => ({
      ...message,
      fileChanges: message.fileChanges?.map((changeSet) =>
        changeSet.id === changeSetId ? { ...changeSet, undone: true } : changeSet,
      ),
    })));
  }, [setMessages]);

  const undoFileChanges = useCallback(async (changeSet: FileChangeSet) => {
    if (!currentSessionId || changeSet.undone) return;
    const resp = await fetch(`${baseUrl}/sessions/${currentSessionId}/file-changes/${changeSet.id}/undo`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      const detail = body?.detail?.message ?? body?.detail ?? "Undo failed";
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    markChangeSetUndone(changeSet.id);
  }, [baseUrl, currentSessionId, markChangeSetUndone, token]);

  const handleSubmit = useCallback(
    async (text: string, attachments: string[] = [], chatImages: ChatImage[] = [], onAccepted?: () => void, submittedAnnotations: ResponseAnnotation[] = []) => {
      if (!isReady) return false;
      if (chatBusy) {
        const accepted = await sendSteer(text, attachments, chatImages, submittedAnnotations);
        if (accepted && submittedAnnotations.length) clearAnnotations();
        return accepted;
      }
      return sendMessage(text, attachments, chatImages, () => {
        if (submittedAnnotations.length) clearAnnotations();
        onAccepted?.();
      }, submittedAnnotations);
    },
    [isReady, chatBusy, sendMessage, sendSteer, clearAnnotations],
  );

  const handleUserInputAnswer = useCallback(
    (text: string) => {
      clearUserInput();
      void handleSubmit(text);
    },
    [clearUserInput, handleSubmit],
  );

  const handleLogout = useCallback(() => {
    // Clear chat state BEFORE dropping the token: otherwise the next login
    // briefly renders the previous user's transcript.
    reset();
    if (sessionRef.current) clearSession(sessionRef.current);
    sessionRef.current = null;
    setCurrentSessionId(null);
    resetApprovalMode();
    panel.closeKinds(["artifact", "review"]);
    logout();
  }, [reset, clearSession, setCurrentSessionId, resetApprovalMode, logout, panel]);

  const handleNewChat = useCallback(async () => {
    sessionRef.current = null;
    setCurrentSessionId(null);
    resetApprovalMode();
    panel.closeKinds(["artifact", "review"]);
    // "Default side panel" (General). Files and Agents are workspace-scoped, so
    // they survive closeKinds above and only need opening when not already up.
    if (defaultPanel === "files") openFilesExplorer();
    else if (defaultPanel === "tasks") openAgentsPanel();
    if (window.location.hash !== "" && window.location.hash !== "#/") {
      window.location.hash = "/";
    }
  }, [setCurrentSessionId, resetApprovalMode, panel, defaultPanel, openFilesExplorer, openAgentsPanel]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === sessionRef.current) return;

      panel.closeKinds(["artifact", "review"]);
      const oldSid = sessionRef.current;
      sessionRef.current = sessionId;
      if (window.location.hash !== `#/c/${sessionId}`) {
        window.location.hash = `/c/${sessionId}`;
      }

      try {
        if (isSessionLoading(sessionId)) return;
        const msgs = await loadSession(sessionId);
        await fetch(`${baseUrl}/restore?session_id=${sessionId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ messages: msgs }),
        });
        setMessagesForSession(
          sessionId,
          msgs.map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: m.content,
            steps: m.steps as ToolStep[] | undefined,
            artifacts: m.artifacts as Artifact[] | undefined,
            fileChanges: m.fileChanges as FileChangeSet[] | undefined,
            attachments: m.attachments,
            chatImages: m.chatImages,
            annotations: m.annotations,
            task: m.task,
          })),
        );
      } catch {
        if (sessionRef.current === sessionId) {
          sessionRef.current = oldSid;
          handleNewChat();
        }
      }
    },
    [baseUrl, isSessionLoading, loadSession, setMessagesForSession, token, handleNewChat, panel],
  );

  useEffect(() => {
    const handleHashChange = (): Promise<void> | void => {
      const hash = window.location.hash;
      const isUtilityPath = window.location.pathname === "/admin" || window.location.pathname === "/settings";
      const routeLocation = isUtilityPath
        ? `${window.location.pathname}${window.location.search}`
        : window.location.hash;
      const [route, query = ""] = routeLocation.replace(/^#/, "").split("?");
      const params = new URLSearchParams(query);
      if (route === "/admin" || route === "/settings") {
        setSettingsOpen(true);
        const requested = params.get("tab") ?? "";
        // `integrations` was the old id for the per-user connections tab; keep
        // existing links working.
        const section = requested === "integrations" ? "connections" : requested;
        if (SETTINGS_SECTION_IDS.has(section)) setSettingsSection(section as SettingsSectionId);
        return;
      }
      setSettingsOpen(false);
      const match = hash.match(/^#\/c\/(.+)$/);
      if (match) {
        const sid = match[1];
        if (sid !== sessionRef.current) return handleResumeSession(sid);
      } else if (hash === "" || hash === "#/") {
        if (sessionRef.current) handleNewChat();
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    window.addEventListener("popstate", handleHashChange);
    if (isReady && isMultiUser !== undefined && !initialSyncRef.current) {
      initialSyncRef.current = true;
      // Keep the boot screen up until the deep-linked session (if any) has
      // loaded — otherwise the home screen flashes before the chat appears.
      void Promise.resolve(handleHashChange()).finally(() => setRouteBooting(false));
    }
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
      window.removeEventListener("popstate", handleHashChange);
    };
  }, [isReady, isMultiUser, handleResumeSession, handleNewChat]);

  const handleFork = useCallback(
    async (messageIndex: number) => {
      const sid = sessionRef.current;
      if (!sid) return;
      try {
        const newId = await forkSession(sid, messageIndex);
        const msgs = await loadSession(newId);
        await fetch(`${baseUrl}/restore?session_id=${newId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ messages: msgs }),
        });
        setMessagesForSession(
          newId,
          msgs.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            steps: m.steps as ToolStep[] | undefined,
            artifacts: m.artifacts as Artifact[] | undefined,
            fileChanges: m.fileChanges as FileChangeSet[] | undefined,
            attachments: m.attachments,
            chatImages: m.chatImages,
            annotations: m.annotations,
          })),
        );
        window.location.hash = `/c/${newId}`;
      } catch (err) {
        console.error("Fork failed:", err);
      }
    },
    [forkSession, loadSession, baseUrl, token, setMessagesForSession],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
      clearSession(sessionId);
      if (sessionRef.current === sessionId) {
        panel.closeKinds(["artifact", "review"]);
        sessionRef.current = null;
      }
    },
    [clearSession, deleteSession, panel],
  );

  const handleSlashCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "/reset":
          handleNewChat();
          break;
        case "/settings":
          openSettingsRoute("general");
          break;
        case "/memory":
          openSettingsRoute("memories");
          break;
        case "/init":
          setInitOpen(true);
          break;
        case "/model":
          openSettingsRoute("general");
          break;
        case "/help":
          setHelpOpen(true);
          break;
      }
    },
    [handleNewChat, openSettingsRoute],
  );

  const { uploads, uploadFiles, dismiss: dismissUpload, activeCount, errorCount } = useUploads(
    baseUrl,
    token,
  );

  const handleApproval = useCallback(
    async (action: string, feedback?: string, saveExecpolicy?: boolean) => {
      if (!pendingApproval) return;
      const response = await fetch(`${baseUrl}/approval?session_id=${currentSessionId || "default"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          approval_id: pendingApproval.approvalId,
          action,
          feedback: feedback ?? "",
          save_execpolicy: saveExecpolicy ?? false,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.detail ?? "Could not send approval response");
      }
      clearApproval();
    },
    [baseUrl, pendingApproval, clearApproval, currentSessionId, token],
  );

  const displayError = serverError || chatError || operationError || approvalModeError;
  const loadingCurrentSession = !!currentSessionId && isSessionLoading(currentSessionId);
  const isWelcome = isReady && messages.length === 0 && !chatBusy && !loadingCurrentSession;
  const rawTitle = sessions.find((s) => s.sessionId === currentSessionId)?.title;
  const sessionTitle =
    rawTitle && !["New chat", "New session"].includes(rawTitle)
      ? rawTitle
      : "New chat";

  if (serverError) {
    return <ServerErrorScreen error={serverError} />;
  }

  // Blank boot screen while we don't yet know what to render — server still
  // connecting or auth state unknown. Prevents the chat shell flashing before
  // the login screen (or before a restored session).
  if (!isReady) {
    return <BootScreen />;
  }

  if (isReady && isMultiUser && !token) {
    return (
      <div className="flex h-dvh flex-col">
        <WarningBanner warnings={serverWarnings} />
        <Login onLogin={login} onRegister={register} error={authError || null} />
      </div>
    );
  }

  // Logged in (or single-user), but the initial route hasn't resolved yet —
  // keep the boot screen up instead of flashing the home screen.
  if (routeBooting) {
    return <BootScreen />;
  }

  return (
    <>
      <WorkspaceShell
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        sessionTitle={sessionTitle}
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={() => {
          setRightPanelOpen((open) => !open);
        }}
        artifactOpen={rightPanelOpen}
        artifactExpanded={rightPanelExpanded}
        artifactDefaultSize={filesTabActive ? Math.max(44, artifactDefaultSize) : artifactDefaultSize}
        artifactMinSize={filesTabActive ? 42 : 20}
        artifactMaxSize={70}
        onArtifactResize={setArtifactDefaultSize}
        banners={
          <>
            <WarningBanner warnings={serverWarnings} />
            <ErrorBanner error={displayError} />
          </>
        }
        sidebar={
          <Sidebar
            onNewChat={handleNewChat}
            onOpenSettings={() => openSettingsRoute("general")}
            onOpenInit={() => setInitOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
            isConnected={isReady}
            theme={theme}
            onToggleTheme={toggleTheme}
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            currentSessionId={currentSessionId}
            onResumeSession={handleResumeSession}
            onRenameSession={renameSession}
            onDeleteSession={handleDeleteSession}
            hasModels={models.length > 0}
            onLogout={handleLogout}
            username={user?.username}
            isMultiUser={isMultiUser}
            isAdmin={isAdmin}
            onOpenAdmin={() => openAdminRoute("files")}
          />
        }
        artifactPanel={
          <RightPanel
            tabs={panel.tabs}
            activeKey={panel.activeKey}
            onActivate={panel.activate}
            onCloseTab={(key) => {
              // Leaving a selected agent behind would show its detail view again
              // the next time the tab is opened.
              if (key === "agents") void clearSubagentSelection();
              panel.close(key);
            }}
            visible={rightPanelOpen}
            onHide={hidePanel}
            launcherItems={launcherItems}
            expanded={rightPanelExpanded}
            onToggleExpand={toggleRightPanelExpanded}
            renderSurface={(open) =>
              open.tab.kind === "agents" ? (
            <AgentsPanel
              active={activeSubagents}
              done={doneSubagents}
              selectedId={selectedSubagentId}
              detail={subagentDetail}
              onSelect={(id) => {
                void selectAgent(id);
              }}
              onBack={() => {
                void clearSubagentSelection();
              }}
              onStop={async (id) => {
                await stopSubagent(id);
              }}
              onStopTerminal={async (taskId) => {
                if (!currentSessionId) return;
                const response = await fetch(`${baseUrl}/sessions/${currentSessionId}/tasks/${taskId}/stop`, {
                  method: "POST",
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!response.ok) {
                  const detail = await response.text();
                  throw new Error(detail || "Could not stop command");
                }
                const payload = await response.json();
                if (payload.task) {
                  setMessages((previous) => previous.map((message) => (
                    message.role === "system" && message.task?.task_id === taskId
                      ? { ...message, task: payload.task }
                      : message
                  )));
                }
              }}
              onSend={async (id, message) => {
                await sendSubagentMessage(id, message);
              }}
              onOpenArtifact={openArtifact}
              onOpenFileChanges={openFileChanges}
              onUndoFileChanges={(changeSet) => {
                void undoFileChanges(changeSet).catch((err) => {
                  setOperationError(
                    err instanceof Error ? err.message : "Undo failed",
                  );
                });
              }}
              baseUrl={baseUrl}
              token={token}
              terminalTasks={terminalTasks}
            />
              ) : open.tab.kind === "files" ? (
                <FileExplorerPanel
                  baseUrl={baseUrl}
                  token={token}
                  refreshSignal={`${messages.length}:${chatBusy ? "running" : "idle"}`}
                  onTitleChange={(title) => panel.setTitle(open.key, title)}
                  uploads={uploads}
                  uploadActiveCount={activeCount}
                  uploadErrorCount={errorCount}
                  onUpload={isMultiUser ? uploadFiles : undefined}
                  onDismissUpload={isMultiUser ? dismissUpload : undefined}
                />
              ) : open.tab.kind === "artifact" ? (
                <ArtifactPanel
                  artifact={open.tab.artifact}
                  baseUrl={baseUrl}
                  token={token}
                  embedded
                />
              ) : (
                <FileChangePanel changeSet={open.tab.changeSet} />
              )
            }
          />
        }
      >
        <div className="flex flex-col flex-1 min-h-0">
          {isWelcome && (
            <div className="relative flex-1 flex flex-col items-center min-h-0 overflow-y-auto">
              <WelcomeScene />
              {/* welcome-block carries the density preference and the top anchor;
                  see globals.css. */}
              <div className="welcome-block relative z-10 flex w-full max-w-[42rem] flex-col px-5">
                <WelcomeContent />
                {/* Extra headroom so the pet standing on the composer doesn't
                    crowd the hero title; he strolls this ledge while idle. */}
                <div className="relative mt-[var(--welcome-headroom)]">
                  <div className="absolute inset-x-0 top-0 h-0">
                    <PixelPet working={chatBusy} size={40} idleStrollEveryMs={90_000} />
                  </div>
                <InputBar
                  baseUrl={baseUrl}
                  onSubmit={handleSubmit}
                  onSlashCommand={handleSlashCommand}
                  disabled={chatBusy || !isReady}
                  isLoading={chatBusy}
                  onStop={stop}
                  models={models}
                  capabilities={capabilities}
                  requiresVision={messages.some((m) => !!m.chatImages?.length || m.attachments?.some((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)))}
                  ensureSession={ensureComposerSession}
                  currentModel={currentModel}
                  onSelectModel={(model) => setModel(model, sessionRef.current)}
                  approvalMode={approvalMode}
                  onSelectApprovalMode={setApprovalMode}
                  approvalModeChanging={approvalModeChanging}
                  token={token}
                  uploadingCount={activeCount}
                  onUpload={isMultiUser ? uploadFiles : undefined}
                  annotations={annotations}
                  onUpdateAnnotation={updateAnnotation}
                  onRemoveAnnotation={removeAnnotation}
                  welcomeMode
                  embedded
                />
                </div>
                {showSuggestions && (
                  <div>
                    <SuggestionChips onSuggestionClick={handleSubmit} />
                  </div>
                )}
              </div>
            </div>
          )}

          {isReady && (messages.length > 0 || chatBusy) && (
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatView
                sessionId={currentSessionId}
                messages={messages}
                streamingSteps={streamingSteps}
                streamingText={streamingText}
                currentTool={currentTool}
                statusMessage={statusMessage}
                activityStartedAt={activityStartedAt}
                isLoading={chatBusy}
                awaitingApproval={!!pendingApproval}
                annotations={annotations}
                onAddAnnotation={addAnnotation}
                onUpdateAnnotation={updateAnnotation}
                onRemoveAnnotation={removeAnnotation}
                onRetry={retryAt}
                onFork={isMultiUser ? handleFork : undefined}
                onOpenArtifact={openArtifact}
                onOpenFileChanges={openFileChanges}
                onUndoFileChanges={(changeSet) => {
                  setOperationError(null);
                  void undoFileChanges(changeSet).catch((err) => {
                    console.error("Undo failed:", err);
                    setOperationError(err instanceof Error ? err.message : "Undo failed");
                  });
                }}
                onOpenMemories={openMemories}
                onOpenTask={(task) => {
                  if (task.task_type === "agent") {
                    openAgentsPanel();
                    void selectAgent(task.task_id);
                  }
                }}
                baseUrl={baseUrl}
                token={token}
              />
            </div>
          )}

          {isReady && !isWelcome && (
            <div className="shrink-0 bg-scout-canvas/95">
              {!agentsTabActive && activeSubagents.length > 0 && (
                <SubagentStatusStrip
                  active={activeSubagents}
                  onOpen={openAgentsPanel}
                />
              )}
              {!pendingUserInput && !pendingApproval && pendingSteers.length === 0 && annotations.length === 0 && (
                <div className="relative z-10 mx-auto h-0 w-full max-w-[46rem] px-4">
                  <PixelPet working={chatBusy || activeSubagents.length > 0} />
                </div>
              )}
              {pendingUserInput && (
                <div className="max-w-[46rem] mx-auto px-4 pb-2">
                  <UserInputCard
                    request={pendingUserInput}
                    onAnswer={handleUserInputAnswer}
                    onDismiss={clearUserInput}
                  />
                </div>
              )}
              {pendingApproval && currentSessionId ? (
                <div className="mx-auto w-full max-w-[46rem] px-4 pb-3 pt-1">
                  <ApprovalDock
                    request={pendingApproval}
                    baseUrl={baseUrl}
                    sessionId={currentSessionId}
                    token={token}
                    onRespond={handleApproval}
                  />
                </div>
              ) : (
                <InputBar
                  baseUrl={baseUrl}
                  onSubmit={handleSubmit}
                  onSlashCommand={handleSlashCommand}
                  disabled={!isReady}
                  isLoading={chatBusy}
                  onStop={stop}
                  models={models}
                  capabilities={capabilities}
                  requiresVision={messages.some((m) => !!m.chatImages?.length || m.attachments?.some((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)))}
                  ensureSession={ensureComposerSession}
                  currentModel={currentModel}
                  onSelectModel={(model) => setModel(model, sessionRef.current)}
                  approvalMode={approvalMode}
                  onSelectApprovalMode={setApprovalMode}
                  approvalModeChanging={approvalModeChanging}
                  modelDisabled={chatBusy}
                  pendingSteers={pendingSteers}
                  onActivateSteer={(steerId) => { void activateSteer(steerId); }}
                  onCancelSteer={(steerId) => { void cancelSteer(steerId); }}
                  token={token}
                  uploadingCount={activeCount}
                  onUpload={isMultiUser ? uploadFiles : undefined}
                  annotations={annotations}
                  onUpdateAnnotation={updateAnnotation}
                  onRemoveAnnotation={removeAnnotation}
                />
              )}
            </div>
          )}
        </div>
      </WorkspaceShell>

      <SettingsSurface
        open={settingsOpen}
        baseUrl={baseUrl}
        isMultiUser={isMultiUser}
        isAdmin={isAdmin}
        token={token}
        initialSection={settingsSection}
        onSectionChange={(section) => {
          setSettingsSection(section);
          window.history.replaceState({}, "", settingsUrl(section));
        }}
        onClose={() => {
          closeSettingsRoute();
          reloadConfig();
        }}
      />

      <InitWizard open={initOpen} baseUrl={baseUrl} token={token} onClose={() => setInitOpen(false)} />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
