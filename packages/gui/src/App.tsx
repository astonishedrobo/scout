import { useState, useCallback, useRef, useEffect } from "react";
import { Bot, FolderTree } from "lucide-react";
import { useServer } from "./hooks/useServer";
import { useChat } from "./hooks/useChat";
import { useConfig } from "./hooks/useConfig";
import { useTheme } from "./hooks/useTheme";
import { useSessions } from "./hooks/useSessions";
import { usePanelPrefs } from "./hooks/usePanelPrefs";
import { useSubagents } from "./hooks/useSubagents";
import type { ToolStep, Artifact, ChatImage, FileChangeSet, ResponseAnnotation, TaskEvent } from "scout-core";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { BootScreen } from "./components/BootScreen";
import { Sidebar } from "./components/Sidebar";
import { ChatView, WelcomeContent, SuggestionChips } from "./components/ChatView";
import { InputBar } from "./components/InputBar";
import { PixelPet } from "./components/PixelPet";
import { WelcomeScene } from "./components/WelcomeScene";
import { ApprovalDock } from "./components/ApprovalDock";
import { SettingsPanel } from "./components/SettingsPanel";
import { InitWizard } from "./components/InitWizard";
import { HelpDialog } from "./components/HelpDialog";
import { WarningBanner } from "./components/WarningBanner";
import { ErrorBanner } from "./components/ErrorBanner";
import { useAuth } from "./hooks/useAuth";
import { useUploads } from "./hooks/useUploads";
import { Login } from "./components/Login";
import { AdminPanel } from "./components/AdminPanel";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { UploadButton } from "./components/UploadButton";
import { UserInputCard } from "./components/UserInputCard";
import { FileChangePanel } from "./components/FileChangePanel";
import { FileExplorerPanel } from "./components/FileExplorerPanel";
import {
  AgentsPanel,
  SubagentStatusStrip,
} from "./components/AgentsPanel";
import { useApprovalMode } from "./hooks/useApprovalMode";
import { useResponseAnnotations } from "./hooks/useResponseAnnotations";
import {
  headerActionActiveClass,
  headerActionButtonClass,
  headerActionIdleClass,
} from "./components/ui/headerControls";

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

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = await createSession();
    sessionRef.current = id;
    window.location.hash = `/c/${id}`;
    return id;
  }, [createSession]);

  const onUserMessage = useCallback(
    async () => ensureSession(),
    [ensureSession],
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
  const {
    mode: approvalMode,
    setMode: setApprovalMode,
    isChanging: approvalModeChanging,
    error: approvalModeError,
  } = useApprovalMode({
    baseUrl,
    sessionId: currentSessionId,
    token,
    isReady,
    ensureSession,
  });
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "models" | "memories" | "integrations">("general");
  const [initOpen, setInitOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<"files" | "users" | "execution" | "mcp" | "config">("files");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [activeFileChanges, setActiveFileChanges] = useState<FileChangeSet | null>(null);
  const [filesExplorerOpen, setFilesExplorerOpen] = useState(false);
  const [agentsPanelOpen, setAgentsPanelOpen] = useState(false);
  const [isAutoContinuing, setIsAutoContinuing] = useState(false);
  const [autoStreamingText, setAutoStreamingText] = useState("");
  const [autoContinueStartedAt, setAutoContinueStartedAt] = useState<number | null>(null);

  const chatRoute = useCallback(() => sessionRef.current ? `/#/c/${sessionRef.current}` : "/#/", []);
  const openSettingsRoute = useCallback((tab: "general" | "models" | "memories" | "integrations" = "general") => {
    setAdminOpen(false);
    setSettingsTab(tab);
    setSettingsOpen(true);
    window.history.pushState({}, "", `/settings?tab=${encodeURIComponent(tab)}`);
  }, []);
  const openAdminRoute = useCallback((tab: "files" | "users" | "execution" | "mcp" | "config" = "files") => {
    setSettingsOpen(false);
    setAdminOpen(true);
    setAdminTab(tab);
    window.history.pushState({}, "", `/admin?tab=${encodeURIComponent(tab)}`);
  }, []);
  const closeSettingsRoute = useCallback(() => {
    setSettingsOpen(false);
    setSettingsTab("general");
    window.history.pushState({}, "", chatRoute());
  }, [chatRoute]);
  const closeAdminRoute = useCallback(() => {
    setAdminOpen(false);
    setAdminTab("files");
    window.history.pushState({}, "", chatRoute());
  }, [chatRoute]);

  const openMemories = useCallback(() => {
    openSettingsRoute("memories");
  }, [openSettingsRoute]);

  /** Right panel is multi-use: opening one mode replaces the previous. Width is preserved. */
  const openArtifact = useCallback((artifact: Artifact) => {
    setActiveFileChanges(null);
    setFilesExplorerOpen(false);
    setAgentsPanelOpen(false);
    setActiveArtifact(artifact);
  }, []);

  const openFileChanges = useCallback((changeSet: FileChangeSet) => {
    setActiveArtifact(null);
    setFilesExplorerOpen(false);
    setAgentsPanelOpen(false);
    setActiveFileChanges(changeSet);
  }, []);

  const openFilesExplorer = useCallback(() => {
    setActiveArtifact(null);
    setActiveFileChanges(null);
    setAgentsPanelOpen(false);
    setFilesExplorerOpen(true);
  }, []);

  const openAgentsPanel = useCallback(() => {
    setActiveArtifact(null);
    setActiveFileChanges(null);
    setFilesExplorerOpen(false);
    setAgentsPanelOpen(true);
  }, []);

  const closeRightPanel = useCallback(() => {
    setActiveArtifact(null);
    setActiveFileChanges(null);
    setFilesExplorerOpen(false);
    setAgentsPanelOpen(false);
  }, []);

  const toggleFilesExplorer = useCallback(() => {
    if (filesExplorerOpen) {
      setFilesExplorerOpen(false);
      return;
    }
    openFilesExplorer();
  }, [filesExplorerOpen, openFilesExplorer]);

  const rightPanelOpen =
    !!activeArtifact || !!activeFileChanges || filesExplorerOpen || agentsPanelOpen;

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

  const [rightPanelExpanded, setRightPanelExpanded] = useState(false);
  const toggleRightPanelExpanded = useCallback(() => setRightPanelExpanded((value) => !value), []);
  useEffect(() => {
    if (!rightPanelOpen) setRightPanelExpanded(false);
  }, [rightPanelOpen]);

  useEffect(() => {
    if (!activeArtifact) return;
    const latest = [...messages]
      .reverse()
      .flatMap((m) => m.artifacts ?? [])
      .find((artifact) => artifact.path === activeArtifact.path);
    if (latest && latest.version !== activeArtifact.version) setActiveArtifact(latest);
  }, [messages, activeArtifact]);

  useEffect(() => {
    if (!activeFileChanges) return;
    const latest = [...messages]
      .reverse()
      .flatMap((m) => m.fileChanges ?? [])
      .find((changeSet) => changeSet.id === activeFileChanges.id);
    if (latest && latest !== activeFileChanges) setActiveFileChanges(latest);
  }, [messages, activeFileChanges]);

  const markChangeSetUndone = useCallback((changeSetId: string) => {
    setMessages((prev) => prev.map((message) => ({
      ...message,
      fileChanges: message.fileChanges?.map((changeSet) =>
        changeSet.id === changeSetId ? { ...changeSet, undone: true } : changeSet,
      ),
    })));
    setActiveFileChanges((current) =>
      current?.id === changeSetId ? { ...current, undone: true } : current,
    );
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

  const handleNewChat = useCallback(async () => {
    sessionRef.current = null;
    setCurrentSessionId(null);
    setActiveArtifact(null);
    setActiveFileChanges(null);
    if (window.location.hash !== "" && window.location.hash !== "#/") {
      window.location.hash = "/";
    }
  }, [setCurrentSessionId]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === sessionRef.current) return;

      setActiveArtifact(null);
      setActiveFileChanges(null);
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
    [baseUrl, isSessionLoading, loadSession, setMessagesForSession, token, handleNewChat],
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
      if (route === "/admin") {
        setSettingsOpen(false);
        setAdminOpen(true);
        const adminRouteTab = params.get("tab");
        if (["files", "users", "execution", "mcp", "config"].includes(adminRouteTab ?? "")) {
          setAdminTab(adminRouteTab as "files" | "users" | "execution" | "mcp" | "config");
        }
        return;
      }
      if (route === "/settings") {
        setAdminOpen(false);
        setSettingsOpen(true);
        const settingsRouteTab = params.get("tab");
        if (["general", "models", "memories", "integrations"].includes(settingsRouteTab ?? "")) {
          setSettingsTab(settingsRouteTab as "general" | "models" | "memories" | "integrations");
        }
        return;
      }
      setSettingsOpen(false);
      setAdminOpen(false);
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
        setActiveArtifact(null);
        setActiveFileChanges(null);
        sessionRef.current = null;
      }
    },
    [clearSession, deleteSession],
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
  const isWelcome = isReady && messages.length === 0 && !chatBusy;
  const rawTitle = sessions.find((s) => s.sessionId === currentSessionId)?.title;
  const sessionTitle =
    rawTitle && !["New chat", "New session"].includes(rawTitle)
      ? rawTitle
      : "New chat";

  // Blank boot screen while we don't yet know what to render — server still
  // connecting or auth state unknown. Prevents the chat shell flashing before
  // the login screen (or before a restored session).
  if (!isReady && !serverError) {
    return <BootScreen />;
  }

  if (isReady && isMultiUser && !token && !serverError) {
    return (
      <div className="flex h-screen flex-col">
        <WarningBanner warnings={serverWarnings} />
        <Login onLogin={login} onRegister={register} error={authError || null} />
      </div>
    );
  }

  // Logged in (or single-user), but the initial route hasn't resolved yet —
  // keep the boot screen up instead of flashing the home screen.
  if (routeBooting && !serverError) {
    return <BootScreen />;
  }

  return (
    <>
      <WorkspaceShell
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        sessionTitle={sessionTitle}
        headerActions={
          <>
            <button
              type="button"
              onClick={toggleFilesExplorer}
              className={`${headerActionButtonClass} ${
                filesExplorerOpen
                  ? headerActionActiveClass
                  : headerActionIdleClass
              }`}
              title={filesExplorerOpen ? "Close files" : "Browse workspace files"}
              aria-label="Browse files"
              aria-pressed={filesExplorerOpen}
            >
              <FolderTree size={15} />
              <span className="hidden sm:inline">Files</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (agentsPanelOpen) {
                  setAgentsPanelOpen(false);
                  void clearSubagentSelection();
                } else {
                  openAgentsPanel();
                }
              }}
              className={`${headerActionButtonClass} ${
                agentsPanelOpen ? headerActionActiveClass : headerActionIdleClass
              }`}
              title={agentsPanelOpen ? "Close tasks" : "Tasks"}
              aria-label="Tasks"
              aria-pressed={agentsPanelOpen}
            >
              <Bot size={15} />
              <span className="hidden sm:inline">Tasks</span>
              {activeSubagents.length > 0 && (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-scout-accent/20 px-1 text-[10px] font-semibold text-scout-accent">
                  {activeSubagents.length}
                </span>
              )}
            </button>
            {isMultiUser && (
              <UploadButton
                uploads={uploads}
                activeCount={activeCount}
                errorCount={errorCount}
                onUpload={uploadFiles}
                onDismiss={dismissUpload}
              />
            )}
          </>
        }
        artifactOpen={rightPanelOpen}
        artifactExpanded={rightPanelExpanded}
        artifactDefaultSize={filesExplorerOpen ? Math.max(44, artifactDefaultSize) : artifactDefaultSize}
        artifactMinSize={filesExplorerOpen ? 42 : 20}
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
            onLogout={logout}
            username={user?.username}
            isMultiUser={isMultiUser}
            isAdmin={isAdmin}
            onOpenAdmin={() => openAdminRoute("files")}
          />
        }
        artifactPanel={
          agentsPanelOpen ? (
            <AgentsPanel
              active={activeSubagents}
              done={doneSubagents}
              selectedId={selectedSubagentId}
              detail={subagentDetail}
              expanded={rightPanelExpanded}
              onToggleExpand={toggleRightPanelExpanded}
              onClose={() => {
                setAgentsPanelOpen(false);
                void clearSubagentSelection();
              }}
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
          ) : filesExplorerOpen ? (
            <FileExplorerPanel
              baseUrl={baseUrl}
              token={token}
              onClose={closeRightPanel}
              refreshSignal={`${messages.length}:${chatBusy ? "running" : "idle"}`}
              expanded={rightPanelExpanded}
              onToggleExpand={toggleRightPanelExpanded}
            />
          ) : activeArtifact ? (
            <ArtifactPanel
              artifact={activeArtifact}
              baseUrl={baseUrl}
              token={token}
              onClose={closeRightPanel}
              embedded
              expanded={rightPanelExpanded}
              onToggleExpand={toggleRightPanelExpanded}
            />
          ) : activeFileChanges ? (
            <FileChangePanel
              changeSet={activeFileChanges}
              onClose={closeRightPanel}
              expanded={rightPanelExpanded}
              onToggleExpand={toggleRightPanelExpanded}
            />
          ) : undefined
        }
      >
        <div className="flex flex-col flex-1 min-h-0">
          {isWelcome && (
            <div className="relative flex-1 flex flex-col items-center justify-center min-h-0 overflow-y-auto py-8">
              <WelcomeScene />
              <div className="relative z-10 flex w-full max-w-[42rem] flex-col gap-5 px-5">
                <WelcomeContent />
                {/* Extra headroom so the pet standing on the composer doesn't
                    crowd the hero title; he strolls this ledge while idle. */}
                <div className="relative mt-9">
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
                  ensureSession={ensureSession}
                  currentModel={currentModel}
                  onSelectModel={(model) => setModel(model, sessionRef.current)}
                  approvalMode={approvalMode}
                  onSelectApprovalMode={setApprovalMode}
                  approvalModeChanging={approvalModeChanging}
                  isMultiUser={isMultiUser}
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
                <div>
                  <SuggestionChips onSuggestionClick={handleSubmit} />
                </div>
              </div>
            </div>
          )}

          {isReady && (messages.length > 0 || chatBusy) && (
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatView
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
              {!agentsPanelOpen && activeSubagents.length > 0 && (
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
                  ensureSession={ensureSession}
                  currentModel={currentModel}
                  onSelectModel={(model) => setModel(model, sessionRef.current)}
                  approvalMode={approvalMode}
                  onSelectApprovalMode={setApprovalMode}
                  approvalModeChanging={approvalModeChanging}
                  modelDisabled={chatBusy}
                  pendingSteers={pendingSteers}
                  onActivateSteer={(steerId) => { void activateSteer(steerId); }}
                  onCancelSteer={(steerId) => { void cancelSteer(steerId); }}
                  isMultiUser={isMultiUser}
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

      <SettingsPanel
        open={settingsOpen}
        baseUrl={baseUrl}
        isMultiUser={isMultiUser}
        token={token}
        initialTab={settingsTab}
        onTabChange={(tab) => { window.history.replaceState({}, "", `/settings?tab=${encodeURIComponent(tab)}`); }}
        onClose={() => {
          closeSettingsRoute();
          reloadConfig();
        }}
      />

      <InitWizard open={initOpen} baseUrl={baseUrl} onClose={() => setInitOpen(false)} />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      <AdminPanel
        open={adminOpen}
        onClose={closeAdminRoute}
        baseUrl={baseUrl}
        token={token}
        initialTab={adminTab}
        onTabChange={(tab) => { window.history.replaceState({}, "", `/admin?tab=${encodeURIComponent(tab)}`); }}
      />
    </>
  );
}
