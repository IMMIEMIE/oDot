import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  FileCode2,
  FolderOpen,
  History,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Terminal,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  approveToolCall,
  compactSession,
  continueSession,
  createSession,
  deleteSession,
  fetchProjectFiles,
  getSessionEvents,
  listSessions,
  loadShellPolicy,
  loadProviderConfig,
  pickProjectDirectory,
  rejectToolCall,
  rollbackSnapshot,
  saveProviderConfig,
  saveShellPolicy,
  submitPrompt,
  type AgentMode,
  type EventRecord,
  type ProjectFile,
  type ProviderConfigFileResponse,
  type ProviderRecord,
  type SessionEventsResponse,
  type SessionRecord,
  type ShellPolicy,
  type ShellMode,
  type SnapshotRecord
} from "./api";

const EMPTY_EVENTS: SessionEventsResponse = {
  events: [],
  snapshots: [],
  summaries: []
};

type Notice = {
  tone: "info" | "success" | "error";
  text: string;
};

type TreeNode = {
  type: "dir" | "file";
  name: string;
  path: string;
  file?: ProjectFile;
  children: TreeNode[];
};

export function App() {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [configContent, setConfigContent] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [fileFilter, setFileFilter] = useState("");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [mode, setMode] = useState<AgentMode>("agent");
  const [shellMode, setShellMode] = useState<ShellMode>("manual");
  const [shellPolicy, setShellPolicy] = useState<ShellPolicy>({
    autoAllowlist: []
  });
  const [eventsResponse, setEventsResponse] =
    useState<SessionEventsResponse>(EMPTY_EVENTS);
  const [streamingEventId, setStreamingEventId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>({
    tone: "info",
    text: "准备就绪"
  });
  const [isBooting, setIsBooting] = useState(true);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() => {
    const stored = Number(localStorage.getItem("odot.leftWidth"));
    return Number.isFinite(stored) && stored >= 300 ? stored : 420;
  });

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    localStorage.setItem("odot.leftWidth", String(leftWidth));
  }, [leftWidth]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId]
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const availableSessions = useMemo(
    () =>
      sessions.filter((session) =>
        providers.some((provider) => provider.id === session.providerId)
      ),
    [providers, sessions]
  );

  const filteredFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    if (!query) {
      return files;
    }
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [fileFilter, files]);

  const fileTree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  const pendingToolEvents = useMemo(() => {
    const resolved = new Set(
      eventsResponse.events
        .map((event) => valueAsString(event.data.pendingEventId))
        .filter(Boolean)
    );
    return eventsResponse.events.filter(
      (event) => event.type === "tool.pending" && !resolved.has(event.id)
    );
  }, [eventsResponse.events]);

  const contextUsage = useMemo(
    () =>
      estimateContextUsage({
        eventsResponse,
        configContent,
        selectedProviderId,
        draftPrompt: prompt
      }),
    [configContent, eventsResponse, prompt, selectedProviderId]
  );

  async function bootstrap() {
    setIsBooting(true);
    try {
      const [config, nextSessions, policy] = await Promise.all([
        loadProviderConfig(projectRoot),
        listSessions(),
        loadShellPolicy()
      ]);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      setSessions(nextSessions);
      setShellPolicy(policy);
      const preferredProviderId = preferredConfigProviderId(config);
      if (preferredProviderId) {
        setSelectedProviderId(preferredProviderId);
      }
      const restorableSession = nextSessions[0];
      if (restorableSession) {
        await selectSession(restorableSession);
      }
      setNotice({ tone: "success", text: "工作区已加载" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsBooting(false);
    }
  }

  async function reloadProviderConfig() {
    try {
      const config = await loadProviderConfig(projectRoot);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      const preferredProviderId = preferredConfigProviderId(config);
      if (
        preferredProviderId !== selectedProviderId ||
        !config.providers.some((provider) => provider.id === selectedProviderId)
      ) {
        setSelectedProviderId(preferredProviderId);
        setSelectedSessionId("");
        setEventsResponse(EMPTY_EVENTS);
      }
      setNotice({ tone: "success", text: "AI 服务配置已重新加载" });
    } catch (error) {
      reportError(error);
    }
  }

  async function saveConfig() {
    setIsSavingConfig(true);
    try {
      await applyProviderConfig(configContent);
      setNotice({ tone: "success", text: "AI 服务配置已保存并同步" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsSavingConfig(false);
    }
  }

  async function applyProviderConfig(content: string) {
    const config = await saveProviderConfig(content, projectRoot);
    setConfigPath(config.path);
    setConfigContent(config.content);
    setProviders(config.providers);
    const preferredProviderId = preferredConfigProviderId(config);
    if (
      preferredProviderId !== selectedProviderId ||
      !config.providers.some((provider) => provider.id === selectedProviderId)
    ) {
      setSelectedProviderId(preferredProviderId);
      setSelectedSessionId("");
      setEventsResponse(EMPTY_EVENTS);
    }
    return config;
  }

  async function saveSettings(content: string, policy: ShellPolicy) {
    setIsSavingConfig(true);
    try {
      const [config, savedPolicy] = await Promise.all([
        saveProviderConfig(content, projectRoot),
        saveShellPolicy(policy)
      ]);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      setShellPolicy(savedPolicy);
      const preferredProviderId = preferredConfigProviderId(config);
      if (
        preferredProviderId !== selectedProviderId ||
        !config.providers.some((provider) => provider.id === selectedProviderId)
      ) {
        setSelectedProviderId(preferredProviderId);
        setSelectedSessionId("");
        setEventsResponse(EMPTY_EVENTS);
      }
      setIsSettingsOpen(false);
      setNotice({ tone: "success", text: "设置已保存" });
    } catch (error) {
      reportError(error);
      throw error;
    } finally {
      setIsSavingConfig(false);
    }
  }

  async function selectSession(session: SessionRecord) {
    const config = await loadProviderConfig(session.projectRoot);
    setConfigPath(config.path);
    setConfigContent(config.content);
    setProviders(config.providers);

    setSelectedSessionId(session.id);
    setProjectRoot(session.projectRoot);
    setMode(session.mode);
    setShellMode(session.shellMode);
    const sessionProviderExists = config.providers.some(
      (provider) => provider.id === session.providerId
    );
    setSelectedProviderId(
      sessionProviderExists ? session.providerId : preferredConfigProviderId(config)
    );
    await Promise.all([loadEvents(session.id), loadFiles(session.projectRoot)]);
    if (!sessionProviderExists) {
      setNotice({ tone: "error", text: "该会话引用的 AI 服务配置已不存在" });
    }
  }

  async function refreshSessions() {
    const nextSessions = await listSessions();
    setSessions(nextSessions);
    return nextSessions;
  }

  async function loadEvents(sessionId = selectedSessionId) {
    if (!sessionId) {
      setEventsResponse(EMPTY_EVENTS);
      setStreamingEventId(null);
      return EMPTY_EVENTS;
    }
    const response = await getSessionEvents(sessionId);
    setEventsResponse(response);
    setStreamingEventId(null);
    return response;
  }

  async function loadFiles(root = projectRoot) {
    if (!root.trim()) {
      setFiles([]);
      return;
    }
    setIsLoadingFiles(true);
    try {
      const nextFiles = await fetchProjectFiles(root);
      setFiles(nextFiles);
      setSelectedPaths(new Set());
      setExpandedDirs(new Set(initialExpandedDirs(nextFiles)));
      setNotice({ tone: "success", text: `已索引 ${nextFiles.length} 个文件` });
    } catch (error) {
      setFiles([]);
      reportError(error);
    } finally {
      setIsLoadingFiles(false);
    }
  }

  async function chooseProjectDirectory() {
    try {
      const selected = await pickProjectDirectory();
      if (!selected) {
        return;
      }
      setProjectRoot(selected);
      setSelectedSessionId("");
      setEventsResponse(EMPTY_EVENTS);
      const config = await loadProviderConfig(selected);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      setSelectedProviderId(preferredConfigProviderId(config));
      await loadFiles(selected);
    } catch (error) {
      reportError(error);
    }
  }

  async function ensureSession(): Promise<SessionRecord> {
    const providerExists = providers.some(
      (provider) => provider.id === selectedProviderId
    );
    if (!selectedProviderId || !providerExists) {
      throw new Error("当前 AI 服务配置不存在，请先在 JSON 中保存并选择一个服务。");
    }
    if (!projectRoot.trim()) {
      throw new Error("请先选择项目目录。");
    }
    if (selectedSession && sessionMatchesCurrentConfig(selectedSession)) {
      return selectedSession;
    }

    setSelectedSessionId("");
    setEventsResponse(EMPTY_EVENTS);
    return createCurrentSession();
  }

  function sessionMatchesCurrentConfig(session: SessionRecord) {
    return (
      session.providerId === selectedProviderId &&
      session.projectRoot === projectRoot &&
      session.mode === mode &&
      session.shellMode === shellMode
    );
  }

  async function createCurrentSession() {
    setIsCreatingSession(true);
    try {
      const session = await createSession({
        projectRoot,
        mode,
        providerId: selectedProviderId,
        shellMode,
        title: projectRoot.split(/[\\/]/).filter(Boolean).pop()
      });
      await refreshSessions();
      setSelectedSessionId(session.id);
      setNotice({ tone: "success", text: "会话已创建" });
      await loadEvents(session.id);
      return session;
    } catch (error) {
      reportError(error);
      throw error;
    } finally {
      setIsCreatingSession(false);
    }
  }

  async function handleSubmitPrompt() {
    if (!prompt.trim() || isSubmitting) {
      return;
    }
    let liveRefreshTimer: number | undefined;
    setIsSubmitting(true);
    try {
      const session = await ensureSession();
      const previousMaxSeq = eventsResponse.events.at(-1)?.seq ?? 0;
      liveRefreshTimer = window.setInterval(() => {
        void getSessionEvents(session.id)
          .then((partialResponse) => setEventsResponse(partialResponse))
          .catch(() => undefined);
      }, 700);
      const selectedFileText = Array.from(selectedPaths).sort().join("\n");
      const finalPrompt = selectedFileText
        ? `${prompt}\n\n已选择文件:\n${selectedFileText}`
        : prompt;
      const response = await submitPrompt({
        sessionId: session.id,
        prompt: finalPrompt
      });
      const latestAssistantEvent = [...response.events]
        .reverse()
        .find(
          (event) =>
            event.type === "assistant.message" && event.seq > previousMaxSeq
        );
      setEventsResponse(response);
      setStreamingEventId(latestAssistantEvent?.id ?? null);
      await refreshSessions();
      setPrompt("");
      setNotice({ tone: "success", text: "Agent 步骤已完成" });
    } catch (error) {
      reportError(error);
      if (selectedSessionId) {
        await loadEvents(selectedSessionId).catch(() => undefined);
      }
    } finally {
      if (liveRefreshTimer) {
        window.clearInterval(liveRefreshTimer);
      }
      setIsSubmitting(false);
    }
  }

  async function handleApprove(eventId: string) {
    let liveRefreshTimer: number | undefined;
    setIsMutating(true);
    try {
      const sessionId = selectedSessionId;
      await approveToolCall(eventId);
      if (sessionId) {
        liveRefreshTimer = window.setInterval(() => {
          void getSessionEvents(sessionId)
            .then((partialResponse) => setEventsResponse(partialResponse))
            .catch(() => undefined);
        }, 700);
        const response = await continueSession(sessionId);
        setEventsResponse(response);
      } else {
        await loadEvents();
      }
      setNotice({ tone: "success", text: "命令已批准" });
    } catch (error) {
      reportError(error);
    } finally {
      if (liveRefreshTimer) {
        window.clearInterval(liveRefreshTimer);
      }
      setIsMutating(false);
    }
  }

  async function handleReject(eventId: string) {
    setIsMutating(true);
    try {
      await rejectToolCall(eventId);
      await loadEvents();
      setNotice({ tone: "success", text: "命令已拒绝" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleRollback(snapshotId: string) {
    setIsMutating(true);
    try {
      await rollbackSnapshot(snapshotId);
      await loadEvents();
      await loadFiles(projectRoot);
      setNotice({ tone: "success", text: "快照已回滚" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleCompact() {
    if (!selectedSessionId) {
      return;
    }
    setIsMutating(true);
    try {
      await compactSession(selectedSessionId);
      await loadEvents();
      setNotice({ tone: "success", text: "上下文已压缩" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    const session = sessions.find((item) => item.id === sessionId);
    const confirmed = window.confirm(`删除会话「${session?.title ?? sessionId}」？`);
    if (!confirmed) {
      return;
    }

    setIsMutating(true);
    try {
      await deleteSession(sessionId);
      const nextSessions = await listSessions();
      setSessions(nextSessions);
      if (selectedSessionId === sessionId) {
        const nextSession = nextSessions.find((item) =>
          providers.some((provider) => provider.id === item.providerId)
        );
        if (nextSession) {
          await selectSession(nextSession);
        } else {
          setSelectedSessionId("");
          setEventsResponse(EMPTY_EVENTS);
        }
      }
      setNotice({ tone: "success", text: "会话已删除" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  function reportError(error: unknown) {
    const fullError = errorMessage(error);
    setLastError(fullError);
    setNotice({ tone: "error", text: errorSummary(fullError) });
  }

  function toggleFile(path: string) {
    const next = new Set(selectedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setSelectedPaths(next);
  }

  function toggleDirectory(path: string) {
    const next = new Set(expandedDirs);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setExpandedDirs(next);
  }

  function startLeftResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftWidth;

    function onMove(moveEvent: globalThis.PointerEvent) {
      const nextWidth = Math.min(620, Math.max(300, startWidth + moveEvent.clientX - startX));
      setLeftWidth(nextWidth);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      className="appShell"
      style={{
        gridTemplateColumns: `${leftWidth}px 6px minmax(0, 1fr) 344px`
      }}
    >
      <aside className="leftPane">
        <header className="brandRow">
          <span className="brandIcon">
            <Bot size={22} />
          </span>
          <span>
            <strong>oDot</strong>
            <small>本地编程 Agent</small>
          </span>
        </header>

        <section className="leftSection providerConfigSection">
          <div className="sectionTitleRow">
            <SectionTitle icon={<KeyRound size={16} />} title="AI 服务" />
            <button
              className="iconButton ghost"
              aria-label="打开 AI 服务设置"
              onClick={() => setIsSettingsOpen(true)}
            >
              <Settings size={16} />
            </button>
          </div>
          <button className="providerSummary" onClick={() => setIsSettingsOpen(true)}>
            <span>
              <strong>{selectedProvider?.name ?? "未选择服务"}</strong>
              <small>{selectedProvider?.id ?? (configPath || "配置文件尚未加载")}</small>
            </span>
            <Settings size={16} />
          </button>
          <div className="providerMiniActions">
            <button className="iconTextButton" onClick={() => void reloadProviderConfig()}>
              <RefreshCw size={16} />
              重新加载
            </button>
            <button
              className="iconTextButton"
              disabled={isSavingConfig || !configContent.trim()}
              onClick={() => void saveConfig()}
            >
              {isSavingConfig ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
              保存
            </button>
          </div>
        </section>

        <section className="leftSection projectSection">
          <SectionTitle icon={<FolderOpen size={16} />} title="项目文件" />
          <div className="pathRow">
            <input
              value={projectRoot}
              onChange={(event) => setProjectRoot(event.target.value)}
              placeholder="项目目录"
            />
            <button className="iconButton" onClick={chooseProjectDirectory}>
              <FolderOpen size={17} />
            </button>
            <button
              className="iconButton ghost"
              disabled={!projectRoot.trim() || isLoadingFiles}
              onClick={() => void loadFiles()}
            >
              {isLoadingFiles ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            </button>
          </div>
          <div className="searchBox">
            <Search size={15} />
            <input
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              placeholder="筛选文件"
            />
          </div>
          <div className="fileTree" aria-label="项目文件树">
            {fileTree.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                expandedDirs={expandedDirs}
                forceExpanded={Boolean(fileFilter.trim())}
                selectedPaths={selectedPaths}
                onToggleDirectory={toggleDirectory}
                onToggleFile={toggleFile}
              />
            ))}
            {!files.length && <EmptyLine text="尚未索引文件" />}
          </div>
        </section>

        <section className="leftSection sessionsSection">
          <SectionTitle icon={<History size={16} />} title="会话" />
          <button
            className="commandButton"
            disabled={
              isCreatingSession || !selectedProviderId || !projectRoot.trim()
            }
            onClick={() => void createCurrentSession().catch(() => undefined)}
          >
            {isCreatingSession ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            新建会话
          </button>
          <div className="stackList">
            {availableSessions.map((session) => (
              <button
                key={session.id}
                className={`listRow ${
                  session.id === selectedSessionId ? "active" : ""
                }`}
                onClick={() => void selectSession(session)}
              >
                <Clock3 size={15} />
                <span>
                  <strong>{session.title}</strong>
                  <small>
                    {modeLabel(session.mode)} / {shellModeLabel(session.shellMode)}
                  </small>
                </span>
                <span
                  className="rowIconAction"
                  role="button"
                  aria-label={`删除会话 ${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteSession(session.id);
                  }}
                >
                  <Trash2 size={14} />
                </span>
              </button>
            ))}
            {!availableSessions.length && <EmptyLine text="暂无可用会话" />}
          </div>
        </section>
      </aside>

      <div
        className="resizeHandle"
        onPointerDown={startLeftResize}
        role="separator"
        aria-label="拖动调整侧边栏宽度"
      />

      <main className="mainPane">
        <header className="topBar">
          <div className="modeControls">
            <Segmented
              value={mode}
              options={[
                ["ask", "问答"],
                ["plan", "计划"],
                ["agent", "执行"]
              ]}
              onChange={(value) => setMode(value as AgentMode)}
            />
            <Segmented
              value={shellMode}
              options={[
                ["manual", "手动命令"],
                ["auto", "自动命令"]
              ]}
              onChange={(value) => setShellMode(value as ShellMode)}
            />
          </div>
          <div className={`notice ${notice.tone}`}>
            {isBooting && <Loader2 className="spin" size={15} />}
            <span>{notice.text}</span>
          </div>
        </header>

        <section className="timelinePane">
          <div className="paneHeader">
            <div>
              <div className="contextUsage" title={contextUsage.title}>
                <span>上下文 {contextUsage.percent}%</span>
                <div className="contextTrack" aria-hidden="true">
                  <i style={{ width: `${contextUsage.percent}%` }} />
                </div>
              </div>
              <strong>{selectedSession?.title ?? "暂无活动会话"}</strong>
              <small>
                {selectedProvider?.name ?? "未选择服务"} / 已选 {selectedPaths.size} 个文件
              </small>
            </div>
            <button
              className="iconTextButton"
              disabled={!selectedSessionId || isMutating}
              onClick={() => void handleCompact()}
            >
              <Database size={16} />
              压缩上下文
            </button>
          </div>

          <div className="timeline">
            {eventsResponse.events.map((event) => (
              <TimelineEvent
                key={event.id}
                event={event}
                stream={event.id === streamingEventId}
              />
            ))}
            {!eventsResponse.events.length && (
              <div className="emptyTimeline">
                <BrainCircuit size={28} />
                <span>输入提示词开始</span>
              </div>
            )}
          </div>

          <div className="promptBar">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="让 oDot 检查、规划、修改、验证或回滚代码。"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  (!event.nativeEvent.isComposing || event.ctrlKey || event.metaKey)
                ) {
                  event.preventDefault();
                  void handleSubmitPrompt();
                }
              }}
            />
            <button
              className="runButton"
              disabled={!prompt.trim() || isSubmitting || !selectedProviderId}
              onClick={() => void handleSubmitPrompt()}
            >
              {isSubmitting ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              运行
            </button>
          </div>
        </section>
      </main>

      <aside className="rightPane">
        {lastError && (
          <section className="rightSection errorSection">
            <SectionTitle icon={<AlertTriangle size={16} />} title="错误详情" />
            <pre className="errorDetails">{lastError}</pre>
            <button className="iconTextButton" onClick={() => setLastError(null)}>
              <X size={16} />
              清除
            </button>
          </section>
        )}

        <section className="rightSection">
          <SectionTitle icon={<Terminal size={16} />} title="命令确认" />
          <div className="stackList">
            {pendingToolEvents.map((event) => (
              <div className="approvalRow" key={event.id}>
                <code>{pendingCommand(event)}</code>
                <div>
                  <button
                    className="iconButton success"
                    disabled={isMutating}
                    onClick={() => void handleApprove(event.id)}
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="iconButton danger"
                    disabled={isMutating}
                    onClick={() => void handleReject(event.id)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
            {!pendingToolEvents.length && <EmptyLine text="暂无待确认命令" />}
          </div>
        </section>

        <section className="rightSection snapshotsSection">
          <SectionTitle icon={<RotateCcw size={16} />} title="变更快照" />
          <div className="snapshotList">
            {eventsResponse.snapshots.map((snapshot) => (
              <SnapshotItem
                key={snapshot.id}
                snapshot={snapshot}
                disabled={isMutating}
                onRollback={handleRollback}
              />
            ))}
            {!eventsResponse.snapshots.length && <EmptyLine text="暂无快照" />}
          </div>
        </section>
      </aside>

      {isSettingsOpen && (
        <SettingsModal
          configPath={configPath}
          configContent={configContent}
          providers={providers}
          selectedProviderId={selectedProviderId}
          shellPolicy={shellPolicy}
          isSaving={isSavingConfig}
          onClose={() => setIsSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
    </div>
  );
}

function SettingsModal({
  configPath,
  configContent,
  providers,
  selectedProviderId,
  shellPolicy,
  isSaving,
  onClose,
  onSave
}: {
  configPath: string;
  configContent: string;
  providers: ProviderRecord[];
  selectedProviderId: string;
  shellPolicy: ShellPolicy;
  isSaving: boolean;
  onClose: () => void;
  onSave: (content: string, policy: ShellPolicy) => Promise<void>;
}) {
  const initial = parseProviderSettings(configContent, selectedProviderId);
  const [providerId, setProviderId] = useState(initial.providerId);
  const [modelId, setModelId] = useState(initial.modelId);
  const [name, setName] = useState(initial.name);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [jsonText, setJsonText] = useState(configContent);
  const [allowlistText, setAllowlistText] = useState(
    shellPolicy.autoAllowlist.join("\n")
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");

  const providerOptions = useMemo(
    () => providerChoices(jsonText, providers, providerId),
    [jsonText, providerId, providers]
  );
  const modelOptions = useMemo(
    () => modelChoices(jsonText, providerId, modelId),
    [jsonText, providerId, modelId]
  );

  function syncFromSelection(nextProviderId: string, nextModelId?: string) {
    const parsed = parseProviderSettings(
      jsonText,
      nextModelId ? `${nextProviderId}/${nextModelId}` : `${nextProviderId}/${modelId}`
    );
    setProviderId(parsed.providerId || nextProviderId);
    setModelId(parsed.modelId || nextModelId || "");
    setName(parsed.name);
    setBaseUrl(parsed.baseUrl);
    setApiKey(parsed.apiKey);
  }

  async function handleSave() {
    setError("");
    try {
      const nextContent = buildProviderConfigContent(jsonText, {
        providerId,
        modelId,
        name,
        baseUrl,
        apiKey
      });
      const nextPolicy = {
        autoAllowlist: allowlistText
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean)
      };
      await onSave(nextContent, nextPolicy);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  return (
    <div className="modalBackdrop" role="presentation">
      <section className="settingsModal" role="dialog" aria-modal="true">
        <header className="modalHeader">
          <div>
            <strong>AI 服务设置</strong>
            <small>{configPath || "配置文件尚未加载"}</small>
          </div>
          <button className="iconButton ghost" onClick={onClose} aria-label="关闭设置">
            <X size={16} />
          </button>
        </header>

        <div className="settingsBody">
          {error && <pre className="modalError">{error}</pre>}

          <div className="settingsGrid">
            <label>
              <span>Provider</span>
              <select
                value={providerId}
                onChange={(event) => syncFromSelection(event.target.value)}
              >
                {providerOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Model</span>
              <select
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  syncFromSelection(providerId, event.target.value);
                }}
              >
                {modelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label className="settingsWide">
              <span>API Key</span>
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                type="password"
              />
            </label>
            <label className="settingsWide">
              <span>自动命令白名单</span>
              <textarea
                className="allowlistEditor"
                value={allowlistText}
                onChange={(event) => setAllowlistText(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <button
            className="advancedToggle"
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            高级 JSON
          </button>
          {showAdvanced && (
            <textarea
              className="settingsJsonEditor"
              value={jsonText}
              onChange={(event) => {
                setJsonText(event.target.value);
                const parsed = parseProviderSettings(event.target.value, `${providerId}/${modelId}`);
                setProviderId(parsed.providerId);
                setModelId(parsed.modelId);
                setName(parsed.name);
                setBaseUrl(parsed.baseUrl);
                setApiKey(parsed.apiKey);
              }}
              spellCheck={false}
            />
          )}
        </div>

        <footer className="modalFooter">
          <button className="iconTextButton" onClick={onClose}>
            取消
          </button>
          <button
            className="commandButton modalSaveButton"
            disabled={isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            保存设置
          </button>
        </footer>
      </section>
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  expandedDirs,
  forceExpanded,
  selectedPaths,
  onToggleDirectory,
  onToggleFile
}: {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  forceExpanded: boolean;
  selectedPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onToggleFile: (path: string) => void;
}) {
  if (node.type === "dir") {
    const expanded = forceExpanded || expandedDirs.has(node.path);
    return (
      <div className="treeGroup">
        <button
          className="treeRow dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onToggleDirectory(node.path)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <FolderOpen size={15} />
          <span>{node.name}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              forceExpanded={forceExpanded}
              selectedPaths={selectedPaths}
              onToggleDirectory={onToggleDirectory}
              onToggleFile={onToggleFile}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      className={`treeRow file ${selectedPaths.has(node.path) ? "active" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onToggleFile(node.path)}
    >
      <span className="treeSpacer" />
      <FileCode2 size={15} />
      <span>{node.name}</span>
      <small>{node.file ? formatBytes(node.file.size) : ""}</small>
    </button>
  );
}

function TimelineEvent({
  event,
  stream = false
}: {
  event: EventRecord;
  stream?: boolean;
}) {
  const isLong = isLongEvent(event);
  const [expanded, setExpanded] = useState(!isLong);

  useEffect(() => {
    setExpanded(!isLongEvent(event));
  }, [event.id, isLong]);

  return (
    <article className={`timelineEvent ${eventTone(event.type)}`}>
      <div className="eventIcon">{eventIcon(event.type)}</div>
      <div className="eventBody">
        <header>
          <button
            type="button"
            className="eventHeaderButton"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <strong>{eventLabel(event)}</strong>
          </button>
          <span>#{event.seq}</span>
        </header>
        {expanded && <EventDetail event={event} stream={stream} />}
      </div>
    </article>
  );
}

function EventDetail({
  event,
  stream = false
}: {
  event: EventRecord;
  stream?: boolean;
}) {
  if (event.type === "prompt.submitted") {
    return <p>{valueAsString(event.data.prompt)}</p>;
  }
  if (event.type === "assistant.message" || event.type === "reasoning.summary") {
    return (
      <MarkdownText
        text={valueAsString(event.data.text)}
        stream={stream && event.type === "assistant.message"}
      />
    );
  }
  if (event.type === "tool.called") {
    return <pre>{JSON.stringify(event.data.input ?? {}, null, 2)}</pre>;
  }
  if (event.type === "tool.success" || event.type === "tool.failed") {
    const result = event.data.result as Record<string, unknown> | undefined;
    const stdout = valueAsString(result?.stdout);
    const stderr = valueAsString(result?.stderr);
    const patch = valueAsString(result?.patch);
    const error = valueAsString(event.data.error);
    return (
      <div className="eventDetailStack">
        {error && <p>{error}</p>}
        {patch && <pre>{patch}</pre>}
        {stdout && <pre>{stdout}</pre>}
        {stderr && <pre>{stderr}</pre>}
        {!error && !patch && !stdout && !stderr && (
          <pre>{JSON.stringify(event.data.result ?? event.data, null, 2)}</pre>
        )}
      </div>
    );
  }
  if (event.type === "tool.pending") {
    return <p>{pendingCommand(event)}</p>;
  }
  if (event.type === "plan.candidateTool" || event.type === "policy.blocked") {
    return <pre>{JSON.stringify(event.data, null, 2)}</pre>;
  }
  return <pre>{JSON.stringify(event.data, null, 2)}</pre>;
}

const LONG_EVENT_CHARS = 1600;
const LONG_EVENT_LINES = 24;
const LONG_MARKDOWN_CHARS = 1200;
const LONG_MARKDOWN_LINES = 18;

function isLongEvent(event: EventRecord) {
  const text = eventTextForLength(event);
  return (
    text.length > LONG_EVENT_CHARS ||
    text.split(/\r?\n/).length > LONG_EVENT_LINES
  );
}

function eventTextForLength(event: EventRecord) {
  if (event.type === "assistant.message" || event.type === "reasoning.summary") {
    return valueAsString(event.data.text);
  }
  if (event.type === "tool.success" || event.type === "tool.failed") {
    const result = event.data.result as Record<string, unknown> | undefined;
    return [
      valueAsString(event.data.error),
      valueAsString(result?.patch),
      valueAsString(result?.stdout),
      valueAsString(result?.stderr)
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (event.type === "prompt.submitted") {
    return valueAsString(event.data.prompt);
  }
  try {
    return JSON.stringify(event.data, null, 2);
  } catch {
    return "";
  }
}

function MarkdownText({
  text,
  stream = false
}: {
  text: string;
  stream?: boolean;
}) {
  const isLong = isLongMarkdown(text);
  const [expanded, setExpanded] = useState(!isLong);
  const [visibleLength, setVisibleLength] = useState(stream ? 0 : text.length);

  useEffect(() => {
    setExpanded(!isLongMarkdown(text));
    if (!stream) {
      setVisibleLength(text.length);
      return undefined;
    }

    setVisibleLength(0);
    const characters = Array.from(text);
    const step = Math.max(4, Math.ceil(characters.length / 140));
    const timer = window.setInterval(() => {
      setVisibleLength((current) => {
        const next = Math.min(characters.length, current + step);
        if (next >= characters.length) {
          window.clearInterval(timer);
        }
        return next;
      });
    }, 18);

    return () => window.clearInterval(timer);
  }, [stream, text]);

  const displayText = stream
    ? Array.from(text).slice(0, visibleLength).join("")
    : text;

  return (
    <div className={`markdownFrame ${isLong && !expanded ? "collapsed" : ""}`}>
      <div className="markdownBody">
        <ReactMarkdown>{displayText}</ReactMarkdown>
      </div>
      {isLong && (
        <button
          type="button"
          className="collapseToggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse" : "Show more"}
        </button>
      )}
    </div>
  );
}

function isLongMarkdown(text: string) {
  return (
    text.length > LONG_MARKDOWN_CHARS ||
    text.split(/\r?\n/).length > LONG_MARKDOWN_LINES
  );
}

function SnapshotItem({
  snapshot,
  disabled,
  onRollback
}: {
  snapshot: SnapshotRecord;
  disabled: boolean;
  onRollback: (snapshotId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="snapshotItem">
      <button className="snapshotHeader" onClick={() => setExpanded(!expanded)}>
        <FileCode2 size={15} />
        <span>{snapshot.path}</span>
        <small>{snapshot.afterContent === null ? "删除" : "写入"}</small>
      </button>
      {expanded && <pre>{snapshot.patch}</pre>}
      <button
        className="rollbackButton"
        disabled={disabled}
        onClick={() => void onRollback(snapshot.id)}
      >
        <RotateCcw size={15} />
        回滚
      </button>
    </article>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="sectionTitle">
      {icon}
      <strong>{title}</strong>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map(([optionValue, label]) => (
        <button
          key={optionValue}
          className={value === optionValue ? "active" : ""}
          onClick={() => onChange(optionValue)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="emptyLine">{text}</div>;
}

function buildFileTree(files: ProjectFile[]): TreeNode[] {
  const root: TreeNode = {
    type: "dir",
    name: "",
    path: "",
    children: []
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const path = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let child = current.children.find((item) => item.name === part);
      if (!child) {
        child = {
          type: isFile ? "file" : "dir",
          name: part,
          path,
          file: isFile ? file : undefined,
          children: []
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  sortTree(root);
  return root.children;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

function initialExpandedDirs(files: ProjectFile[]) {
  const result = new Set<string>();
  for (const file of files.slice(0, 80)) {
    const parts = file.path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      result.add(parts.slice(0, index).join("/"));
    }
  }
  return result;
}

function eventIcon(type: string) {
  if (type.includes("failed") || type.includes("blocked")) {
    return <AlertTriangle size={16} />;
  }
  if (type.startsWith("tool.")) {
    return <Wrench size={16} />;
  }
  if (type.startsWith("reasoning")) {
    return <BrainCircuit size={16} />;
  }
  if (type.startsWith("context")) {
    return <Database size={16} />;
  }
  return <Bot size={16} />;
}

function eventTone(type: string) {
  if (type.includes("failed") || type.includes("blocked")) {
    return "danger";
  }
  if (type.includes("success") || type.includes("approved")) {
    return "success";
  }
  if (type.includes("pending")) {
    return "pending";
  }
  return "neutral";
}

function eventLabel(event: EventRecord) {
  const labels: Record<string, string> = {
    "prompt.submitted": "用户提示词",
    "step.started": "步骤开始",
    "step.ended": "步骤结束",
    "step.failed": "步骤失败",
    "reasoning.summary": "过程摘要",
    "assistant.message": "助手回复",
    "tool.called": "工具调用",
    "tool.success": "工具成功",
    "tool.failed": "工具失败",
    "tool.pending": "等待确认",
    "tool.approved": "已批准工具",
    "tool.rejected": "已拒绝工具",
    "plan.candidateTool": "候选工具",
    "policy.blocked": "策略拦截",
    "rollback.applied": "已回滚",
    "context.compacted": "上下文压缩"
  };
  if (event.type.startsWith("tool.")) {
    return `${labels[event.type] ?? event.type} ${toolLabel(valueAsString(event.data.name))}`.trim();
  }
  return labels[event.type] ?? event.type;
}

function pendingCommand(event: EventRecord) {
  return (
    valueAsString((event.data.pending as Record<string, unknown> | undefined)?.command) ||
    valueAsString(event.data.command) ||
    "待确认命令"
  );
}

function valueAsString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function errorSummary(error: string) {
  return error.split("\n").find((line) => line.trim()) ?? "发生未知错误";
}

function preferredConfigProviderId(config: ProviderConfigFileResponse) {
  return config.selectedProviderId ?? config.providers[0]?.id ?? "";
}

function modeLabel(value: AgentMode) {
  const labels: Record<AgentMode, string> = {
    ask: "问答",
    plan: "计划",
    agent: "执行"
  };
  return labels[value];
}

function shellModeLabel(value: ShellMode) {
  const labels: Record<ShellMode, string> = {
    manual: "手动命令",
    auto: "自动命令"
  };
  return labels[value];
}

function toolLabel(value: string) {
  const labels: Record<string, string> = {
    read: "读取",
    search: "搜索",
    edit: "编辑",
    write: "写入",
    delete: "删除",
    shell: "命令"
  };
  return labels[value] ?? value;
}

type ContextUsageEstimate = {
  percent: number;
  usedTokens: number;
  maxTokens: number;
  title: string;
};

function estimateContextUsage({
  eventsResponse,
  configContent,
  selectedProviderId,
  draftPrompt
}: {
  eventsResponse: SessionEventsResponse;
  configContent: string;
  selectedProviderId: string;
  draftPrompt: string;
}): ContextUsageEstimate {
  const limit = contextLimitFromConfig(configContent, selectedProviderId);
  const maxTokens = limit ?? 128_000;
  const recentEventText = eventsResponse.events
    .slice(-36)
    .map(
      (event) =>
        `#${event.seq} ${event.type} ${truncateText(safeJson(event.data), 2_000)}`
    )
    .join("\n");
  const summaryText = eventsResponse.summaries[0]?.text ?? "";
  const promptShape = [
    "System prompt: local coding agent JSON tool protocol.",
    `Current user prompt:\n${draftPrompt}`,
    `Compressed context:\n${summaryText}`,
    `Recent event timeline:\n${recentEventText}`
  ].join("\n\n");
  const usedTokens = estimateTokens(promptShape);
  const percent = Math.min(100, Math.ceil((usedTokens / maxTokens) * 100));
  const title = [
    `估算使用量: ${formatInteger(usedTokens)} tokens`,
    `上下文上限: ${formatInteger(maxTokens)} tokens${limit ? "" : " (默认估算)"}`,
    `最近事件: ${Math.min(eventsResponse.events.length, 36)} / ${eventsResponse.events.length}`,
    "说明: 按当前发送给模型的压缩上下文估算，非供应商实际 billing usage。"
  ].join("\n");

  return {
    percent,
    usedTokens,
    maxTokens,
    title
  };
}

function contextLimitFromConfig(content: string, selectedProviderId: string) {
  try {
    const config = JSON.parse(content) as Record<string, unknown>;
    const selected = splitProviderRecordId(
      selectedProviderId || valueAsString(config.model)
    );
    const provider = providerRecord(config, selected.providerId);
    const model = asRecord(asRecord(provider.models)[selected.modelId]);
    const limit = asRecord(model.limit);
    return (
      valueAsNumber(limit.context) ||
      valueAsNumber(model.context) ||
      valueAsNumber(asRecord(model.options).context) ||
      valueAsNumber(asRecord(provider.options).context) ||
      null
    );
  } catch {
    return null;
  }
}

function estimateTokens(text: string) {
  let tokens = 0;
  for (const char of text) {
    tokens += char.charCodeAt(0) > 127 ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function valueAsNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

type ProviderSettingsFields = {
  providerId: string;
  modelId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
};

function parseProviderSettings(
  content: string,
  selectedProviderId: string
): ProviderSettingsFields {
  try {
    const config = JSON.parse(content) as Record<string, unknown>;
    const providers = config.provider as Record<string, unknown> | undefined;
    const selected = splitProviderRecordId(
      selectedProviderId || valueAsString(config.model)
    );
    const providerId =
      selected.providerId || (Object.keys(providers ?? {})[0] ?? "");
    const provider = providerRecord(config, providerId);
    const models = provider.models as Record<string, unknown> | undefined;
    const modelId = selected.modelId || (Object.keys(models ?? {})[0] ?? "");
    const options = asRecord(provider.options);
    const model = asRecord(models?.[modelId]);
    const modelProvider = asRecord(model.provider);
    return {
      providerId,
      modelId,
      name: valueAsString(provider.name),
      baseUrl:
        valueAsString(modelProvider.api) ||
        valueAsString(provider.api) ||
        valueAsString(options.baseURL) ||
        valueAsString(options.base_url) ||
        valueAsString(options.api),
      apiKey:
        valueAsString(options.apiKey) ||
        valueAsString(options.api_key) ||
        valueAsString(options.key)
    };
  } catch {
    return {
      providerId: "",
      modelId: "",
      name: "",
      baseUrl: "",
      apiKey: ""
    };
  }
}

function buildProviderConfigContent(
  content: string,
  fields: ProviderSettingsFields
) {
  const config = JSON.parse(content) as Record<string, unknown>;
  const providerId = fields.providerId.trim();
  const modelId = fields.modelId.trim();
  if (!providerId) {
    throw new Error("Provider 不能为空。");
  }
  if (!modelId) {
    throw new Error("Model 不能为空。");
  }

  const providers = ensureRecord(config, "provider");
  const provider = ensureRecord(providers, providerId);
  const options = ensureRecord(provider, "options");
  const models = ensureRecord(provider, "models");
  const model = ensureRecord(models, modelId);

  provider.name = fields.name.trim() || providerId;
  options.baseURL = fields.baseUrl.trim();
  options.apiKey = fields.apiKey.trim();
  model.name = model.name || modelId;
  config.model = `${providerId}/${modelId}`;

  return `${JSON.stringify(config, null, 2)}\n`;
}

function providerChoices(
  content: string,
  providers: ProviderRecord[],
  fallback: string
) {
  try {
    const config = JSON.parse(content) as Record<string, unknown>;
    const provider = asRecord(config.provider);
    const choices = Object.keys(provider);
    const fallbackProvider = splitProviderRecordId(fallback).providerId || fallback;
    if (fallbackProvider && !choices.includes(fallbackProvider)) {
      choices.push(fallbackProvider);
    }
    return choices.length ? choices : providers.map((item) => item.id.split("/")[0]);
  } catch {
    return providers.map((item) => item.id.split("/")[0]);
  }
}

function modelChoices(content: string, providerId: string, fallback: string) {
  try {
    const config = JSON.parse(content) as Record<string, unknown>;
    const provider = providerRecord(config, providerId);
    const models = asRecord(provider.models);
    const choices = Object.keys(models);
    if (fallback && !choices.includes(fallback)) {
      choices.push(fallback);
    }
    return choices.length ? choices : ["default"];
  } catch {
    return fallback ? [fallback] : ["default"];
  }
}

function providerRecord(config: Record<string, unknown>, providerId: string) {
  return asRecord(asRecord(config.provider)[providerId]);
}

function splitProviderRecordId(value: string) {
  const [providerId = "", modelId = ""] = value.split("/");
  return { providerId, modelId };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ensureRecord(target: Record<string, unknown>, key: string) {
  const current = target[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
