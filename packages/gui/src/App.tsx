import { useState, useCallback, useRef, useEffect } from "react";
import { useServer } from "./hooks/useServer";
import { useChat } from "./hooks/useChat";
import { useConfig } from "./hooks/useConfig";
import { useTheme } from "./hooks/useTheme";
import { useSessions } from "./hooks/useSessions";
import { usePanelPrefs } from "./hooks/usePanelPrefs";
import type { ToolStep, Artifact, ChatImage } from "scout-core";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { Sidebar } from "./components/Sidebar";
import { ChatView, WelcomeContent, SuggestionChips } from "./components/ChatView";
import { InputBar } from "./components/InputBar";
import { ApprovalModal } from "./components/ApprovalModal";
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

export function App() {
  const { baseUrl, isReady, isMultiUser, error: serverError, warnings: serverWarnings } = useServer();
  const { token, user, login, register, logout, authError } = useAuth(baseUrl);

  const {
    sessions,
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
    async (sessionId: string, text: string, attachments: string[] = [], chatImages: ChatImage[] = []) => {
      await appendMessage(sessionId, "user", text, { attachments, chat_images: chatImages });
    },
    [appendMessage],
  );

  const onAssistantMessage = useCallback(
    async (sessionId: string, content: string, steps: ToolStep[], artifacts: Artifact[]) => {
      await appendMessage(sessionId, "assistant", content, { steps, artifacts });
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
    isLoading,
    error: chatError,
    pendingApproval,
    clearApproval,
    isSessionLoading,
    clearSession,
    sendMessage,
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
    sidebarCollapsed,
    setSidebarCollapsed,
    artifactDefaultSize,
    setArtifactDefaultSize,
  } = usePanelPrefs();

  const isAdmin = !!user?.is_admin;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "models" | "memories">("general");
  const [initOpen, setInitOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);

  useEffect(() => {
    if (!activeArtifact) return;
    const latest = [...messages]
      .reverse()
      .flatMap((m) => m.artifacts ?? [])
      .find((artifact) => artifact.path === activeArtifact.path);
    if (latest && latest.version !== activeArtifact.version) setActiveArtifact(latest);
  }, [messages, activeArtifact]);

  const handleSubmit = useCallback(
    async (text: string, attachments: string[] = [], chatImages: ChatImage[] = [], onAccepted?: () => void) => {
      if (!isReady || isLoading) return false;
      return sendMessage(text, attachments, chatImages, onAccepted);
    },
    [isReady, isLoading, sendMessage],
  );

  const handleNewChat = useCallback(async () => {
    sessionRef.current = null;
    setCurrentSessionId(null);
    setActiveArtifact(null);
    if (window.location.hash !== "" && window.location.hash !== "#/") {
      window.location.hash = "/";
    }
  }, [setCurrentSessionId]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === sessionRef.current) return;

      setActiveArtifact(null);
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
            role: m.role as "user" | "assistant",
            content: m.content,
            steps: m.steps as ToolStep[] | undefined,
            artifacts: m.artifacts as Artifact[] | undefined,
            attachments: m.attachments,
            chatImages: m.chatImages,
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
    const handleHashChange = () => {
      const hash = window.location.hash;
      const match = hash.match(/^#\/c\/(.+)$/);
      if (match) {
        const sid = match[1];
        if (sid !== sessionRef.current) handleResumeSession(sid);
      } else if (hash === "" || hash === "#/") {
        if (sessionRef.current) handleNewChat();
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    if (isReady && isMultiUser !== undefined && !initialSyncRef.current) {
      handleHashChange();
      initialSyncRef.current = true;
    }
    return () => window.removeEventListener("hashchange", handleHashChange);
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
            attachments: m.attachments,
            chatImages: m.chatImages,
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
          setSettingsTab("general");
          setSettingsOpen(true);
          break;
        case "/memory":
          setSettingsTab("memories");
          setSettingsOpen(true);
          break;
        case "/init":
          setInitOpen(true);
          break;
        case "/model":
          setSettingsOpen(true);
          break;
        case "/help":
          setHelpOpen(true);
          break;
      }
    },
    [handleNewChat],
  );

  const { uploads, uploadFiles, dismiss: dismissUpload, activeCount, errorCount } = useUploads(
    baseUrl,
    token,
  );

  const handleApproval = useCallback(
    async (action: string, feedback?: string, saveExecpolicy?: boolean) => {
      if (!pendingApproval) return;
      await fetch(`${baseUrl}/approval?session_id=${currentSessionId || "default"}`, {
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
      }).catch(() => {});
      clearApproval();
    },
    [baseUrl, pendingApproval, clearApproval, currentSessionId, token],
  );

  const displayError = serverError || chatError;
  const isWelcome = isReady && messages.length === 0 && !isLoading;
  const rawTitle = sessions.find((s) => s.sessionId === currentSessionId)?.title;
  const sessionTitle =
    rawTitle && !["New chat", "New session"].includes(rawTitle)
      ? rawTitle
      : "New chat";

  if (isReady && isMultiUser && !token && !serverError) {
    return (
      <div className="flex flex-col min-h-screen">
        <WarningBanner warnings={serverWarnings} />
        <Login onLogin={login} onRegister={register} error={authError || null} />
      </div>
    );
  }

  return (
    <>
      <WorkspaceShell
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        sessionTitle={sessionTitle}
        isConnected={isReady}
        headerActions={
          isMultiUser ? (
            <UploadButton
              uploads={uploads}
              activeCount={activeCount}
              errorCount={errorCount}
              onUpload={uploadFiles}
              onDismiss={dismissUpload}
            />
          ) : undefined
        }
        artifactOpen={!!activeArtifact}
        artifactDefaultSize={artifactDefaultSize}
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
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenInit={() => setInitOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
            isConnected={isReady}
            theme={theme}
            onToggleTheme={toggleTheme}
            sessions={sessions}
            currentSessionId={currentSessionId}
            onResumeSession={handleResumeSession}
            onRenameSession={renameSession}
            onDeleteSession={handleDeleteSession}
            hasModels={models.length > 0}
            onLogout={logout}
            username={user?.username}
            isMultiUser={isMultiUser}
            isAdmin={isAdmin}
            onOpenAdmin={() => setAdminOpen(true)}
          />
        }
        artifactPanel={
          activeArtifact ? (
            <ArtifactPanel
              artifact={activeArtifact}
              baseUrl={baseUrl}
              token={token}
              onClose={() => setActiveArtifact(null)}
              embedded
            />
          ) : undefined
        }
      >
        <div className="flex flex-col flex-1 min-h-0">
          {!isReady && !serverError && (
            <div className="flex items-center justify-center flex-1">
              <div className="text-center">
                <div className="flex space-x-1.5 justify-center mb-3">
                  <div className="w-2 h-2 rounded-full bg-scout-text thinking-dot" />
                  <div className="w-2 h-2 rounded-full bg-scout-text thinking-dot" />
                  <div className="w-2 h-2 rounded-full bg-scout-text thinking-dot" />
                </div>
                <p className="text-scout-muted">Connecting to server...</p>
              </div>
            </div>
          )}

          {isWelcome && (
            <div className="flex-1 flex flex-col items-center justify-center min-h-0 overflow-y-auto py-8">
              <div className="w-full max-w-2xl px-4 flex flex-col gap-8">
                <WelcomeContent />
                <InputBar
                  baseUrl={baseUrl}
                  onSubmit={handleSubmit}
                  onSlashCommand={handleSlashCommand}
                  disabled={isLoading || !isReady}
                  isLoading={isLoading}
                  onStop={stop}
                  models={models}
                  capabilities={capabilities}
                  requiresVision={messages.some((m) => !!m.chatImages?.length || m.attachments?.some((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)))}
                  ensureSession={ensureSession}
                  currentModel={currentModel}
                  onSelectModel={(model) => setModel(model, sessionRef.current)}
                  isMultiUser={isMultiUser}
                  token={token}
                  uploadingCount={activeCount}
                  onUpload={isMultiUser ? uploadFiles : undefined}
                  welcomeMode
                  embedded
                />
                <div className="-mt-3">
                  <SuggestionChips onSuggestionClick={handleSubmit} />
                </div>
              </div>
            </div>
          )}

          {isReady && (messages.length > 0 || isLoading) && (
            <ChatView
              messages={messages}
              streamingSteps={streamingSteps}
              streamingText={streamingText}
              currentTool={currentTool}
              isLoading={isLoading}
              onRetry={retryAt}
              onFork={isMultiUser ? handleFork : undefined}
              onOpenArtifact={setActiveArtifact}
              baseUrl={baseUrl}
              token={token}
            />
          )}

          {isReady && !isWelcome && (
            <InputBar
              baseUrl={baseUrl}
              onSubmit={handleSubmit}
              onSlashCommand={handleSlashCommand}
              disabled={isLoading || !isReady}
              isLoading={isLoading}
              onStop={stop}
              models={models}
              capabilities={capabilities}
              requiresVision={messages.some((m) => !!m.chatImages?.length || m.attachments?.some((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)))}
              ensureSession={ensureSession}
              currentModel={currentModel}
              onSelectModel={(model) => setModel(model, sessionRef.current)}
              isMultiUser={isMultiUser}
              token={token}
              uploadingCount={activeCount}
              onUpload={isMultiUser ? uploadFiles : undefined}
            />
          )}
        </div>
      </WorkspaceShell>

      {pendingApproval && (
        <ApprovalModal request={pendingApproval} onRespond={handleApproval} />
      )}

      <SettingsPanel
        open={settingsOpen}
        baseUrl={baseUrl}
        isMultiUser={isMultiUser}
        token={token}
        initialTab={settingsTab}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsTab("general");
          reloadConfig();
        }}
      />

      <InitWizard open={initOpen} baseUrl={baseUrl} onClose={() => setInitOpen(false)} />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      <AdminPanel
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        baseUrl={baseUrl}
        token={token}
      />
    </>
  );
}
