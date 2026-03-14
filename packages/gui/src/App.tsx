import { useState, useCallback, useRef, useEffect } from "react";
import { useServer } from "./hooks/useServer";
import { useChat } from "./hooks/useChat";
import { useConfig } from "./hooks/useConfig";
import { useTheme } from "./hooks/useTheme";
import { useSessions } from "./hooks/useSessions";
import type { ToolStep, Message } from "scout-core";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { ChatView, WelcomeContent } from "./components/ChatView";
import { InputBar } from "./components/InputBar";
import { ApprovalModal } from "./components/ApprovalModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { InitWizard } from "./components/InitWizard";
import { HelpDialog } from "./components/HelpDialog";
import { WarningBanner } from "./components/WarningBanner";
import { ErrorBanner } from "./components/ErrorBanner";
import { useAuth } from "./hooks/useAuth";
import { Login } from "./components/Login";

export function App() {
  const { baseUrl, isReady, isMultiUser, error: serverError, warnings: serverWarnings } = useServer();
  const { token, user, login, register, logout, authError } = useAuth(baseUrl);

  const {
    sessions,
    currentSessionId,
    createSession,
    loadSession,
    deleteSession,
    appendMessage,
    setCurrentSessionId,
    refreshSessions,
  } = useSessions(baseUrl, isReady, token, isMultiUser);

  const sessionRef = useRef<string | null>(null);
  sessionRef.current = currentSessionId;
  const initialSyncRef = useRef(false);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    try {
      const id = await createSession();
      sessionRef.current = id;
      window.location.hash = `/c/${id}`;
      return id;
    } catch (err) {
      console.error("Failed to ensure session:", err);
      throw err;
    }
  }, [createSession]);

  const onUserMessage = useCallback(
    async (text: string) => {
      const sid = await ensureSession();
      await appendMessage(sid, "user", text);
    },
    [ensureSession, appendMessage],
  );

  const onAssistantMessage = useCallback(
    async (content: string, steps: ToolStep[]) => {
      const sid = sessionRef.current;
      if (!sid) return;
      await appendMessage(sid, "assistant", content, { steps });
    },
    [appendMessage],
  );

  const {
    messages,
    setMessages,
    streamingSteps,
    currentTool,
    streamingText,
    isLoading,
    error: chatError,
    pendingApproval,
    clearApproval,
    sendMessage,
    retryAt,
    reset,
  } = useChat({
    baseUrl,
    sessionId: currentSessionId || "default",
    token,
    onUserMessage,
    onAssistantMessage,
  });

  const { models, currentModel, setModel, reloadConfig } = useConfig(
    baseUrl,
    isReady,
    token
  );

  const { theme, toggle: toggleTheme } = useTheme();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!isReady || isLoading) return;
      await sendMessage(text);
    },
    [isReady, isLoading, sendMessage],
  );

  const handleNewChat = useCallback(async () => {
    sessionRef.current = null;
    setCurrentSessionId(null);
    if (window.location.hash !== "" && window.location.hash !== "#/") {
      window.location.hash = "/";
    }
    await reset();
  }, [reset, setCurrentSessionId]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === sessionRef.current) return;
      
      const oldSid = sessionRef.current;
      sessionRef.current = sessionId;
      if (window.location.hash !== `#/c/${sessionId}`) {
        window.location.hash = `/c/${sessionId}`;
      }

      try {
        const msgs = await loadSession(sessionId);
        // Restore messages into the agent's backend
        await fetch(`${baseUrl}/restore?session_id=${sessionId}`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ messages: msgs }),
        });
        // Update UI state
        setMessages(
          msgs.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            steps: m.steps as ToolStep[] | undefined,
          })),
        );
      } catch {
        // If session not found or error, revert
        if (sessionRef.current === sessionId) {
          sessionRef.current = oldSid;
          handleNewChat();
        }
      }
    },
    [baseUrl, loadSession, setMessages, token, handleNewChat],
  );

  // Handle URL hash changes for deep linking
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      const match = hash.match(/^#\/c\/(.+)$/);
      if (match) {
        const sid = match[1];
        if (sid !== sessionRef.current) {
          handleResumeSession(sid);
        }
      } else if (hash === "" || hash === "#/") {
        if (sessionRef.current) {
          handleNewChat();
        }
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    // Handle initial state - ONLY once when ready
    if (isReady && isMultiUser !== undefined && !initialSyncRef.current) {
      handleHashChange();
      initialSyncRef.current = true;
    }
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [isReady, isMultiUser, handleResumeSession, handleNewChat]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
      if (sessionRef.current === sessionId) {
        await reset();
        sessionRef.current = null;
      }
    },
    [deleteSession, reset],
  );

  const handleSlashCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "/reset":
          handleNewChat();
          break;
        case "/settings":
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

  const handleApproval = useCallback(
    async (action: string, feedback?: string) => {
      if (!pendingApproval) return;
      await fetch(`${baseUrl}/approval?session_id=${currentSessionId || "default"}`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          approval_id: pendingApproval.approvalId,
          action,
          feedback: feedback ?? "",
        }),
      }).catch(() => {});
      clearApproval();
    },
    [baseUrl, pendingApproval, clearApproval, currentSessionId],
  );

  const displayError = serverError || chatError;

  if (isReady && !token && !serverError) {
    return (
      <div className="flex flex-col min-h-screen bg-scout-bg">
        <WarningBanner warnings={serverWarnings} />
        <Login onLogin={login} onRegister={register} error={authError || null} />
      </div>
    );
  }

  return (
    <Layout
      sidebarOpen={sidebarOpen}
      onToggleSidebar={() => setSidebarOpen((p) => !p)}
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
          onDeleteSession={handleDeleteSession}
          hasModels={models.length > 0}
          onLogout={logout}
          username={user?.username}
          isMultiUser={isMultiUser}
        />
      }
    >
      <div className="flex flex-col flex-1 min-h-0 relative">
        <WarningBanner warnings={serverWarnings} />
        <ErrorBanner error={displayError} />

        {!isReady && !serverError && (
          <div className="flex items-center justify-center flex-1">
            <div className="text-center">
              <div className="flex space-x-1.5 justify-center mb-3">
                <div className="w-2 h-2 rounded-full bg-scout-accent thinking-dot" />
                <div className="w-2 h-2 rounded-full bg-scout-accent thinking-dot" />
                <div className="w-2 h-2 rounded-full bg-scout-accent thinking-dot" />
              </div>
              <p className="text-scout-text-secondary">
                Connecting to server...
              </p>
            </div>
          </div>
        )}

        {isReady && messages.length === 0 && !isLoading && (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <WelcomeContent />
            <div className="w-full mt-6 mb-4">
              <InputBar
                baseUrl={baseUrl}
                onSubmit={handleSubmit}
                onSlashCommand={handleSlashCommand}
                disabled={false}
                models={models}
                currentModel={currentModel}
                onSelectModel={setModel}
                centered
              />
            </div>
          </div>
        )}

        {isReady && (messages.length > 0 || isLoading) && (
          <>
            <ChatView
              messages={messages}
              streamingSteps={streamingSteps}
              streamingText={streamingText}
              currentTool={currentTool}
              isLoading={isLoading}
              onRetry={retryAt}
            />
            <InputBar
              baseUrl={baseUrl}
              onSubmit={handleSubmit}
              onSlashCommand={handleSlashCommand}
              disabled={isLoading || !isReady}
              models={models}
              currentModel={currentModel}
              onSelectModel={setModel}
            />
          </>
        )}
      </div>

      {pendingApproval && (
        <ApprovalModal
          request={pendingApproval}
          onRespond={handleApproval}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          baseUrl={baseUrl}
          isMultiUser={isMultiUser}
          onClose={() => {
            setSettingsOpen(false);
            reloadConfig();
          }}
        />
      )}

      {initOpen && (
        <InitWizard
          baseUrl={baseUrl}
          onClose={() => setInitOpen(false)}
        />
      )}

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </Layout>
  );
}
