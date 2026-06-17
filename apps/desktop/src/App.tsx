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
  Terminal,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import {
  approveToolCall,
  compactSession,
  createSession,
  fetchProjectFiles,
  getSessionEvents,
  listSessions,
  loadProviderConfig,
  pickProjectDirectory,
  rejectToolCall,
  rollbackSnapshot,
  saveProviderConfig,
  submitPrompt,
  type AgentMode,
  type EventRecord,
  type ProjectFile,
  type ProviderConfigFileResponse,
  type ProviderRecord,
  type SessionEventsResponse,
  type SessionRecord,
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
  const [eventsResponse, setEventsResponse] =
    useState<SessionEventsResponse>(EMPTY_EVENTS);
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

  async function bootstrap() {
    setIsBooting(true);
    try {
      const [config, nextSessions] = await Promise.all([
        loadProviderConfig(projectRoot),
        listSessions()
      ]);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      setSessions(nextSessions);
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
      const config = await saveProviderConfig(configContent, projectRoot);
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
      setNotice({ tone: "success", text: "AI 服务配置已保存并同步" });
    } catch (error) {
      reportError(error);
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
      return EMPTY_EVENTS;
    }
    const response = await getSessionEvents(sessionId);
    setEventsResponse(response);
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
    setIsSubmitting(true);
    try {
      const session = await ensureSession();
      const selectedFileText = Array.from(selectedPaths).sort().join("\n");
      const finalPrompt = selectedFileText
        ? `${prompt}\n\n已选择文件:\n${selectedFileText}`
        : prompt;
      const response = await submitPrompt({
        sessionId: session.id,
        prompt: finalPrompt
      });
      setEventsResponse(response);
      await refreshSessions();
      setPrompt("");
      setNotice({ tone: "success", text: "Agent 步骤已完成" });
    } catch (error) {
      reportError(error);
      if (selectedSessionId) {
        await loadEvents(selectedSessionId).catch(() => undefined);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleApprove(eventId: string) {
    setIsMutating(true);
    try {
      await approveToolCall(eventId);
      await loadEvents();
      setNotice({ tone: "success", text: "命令已批准" });
    } catch (error) {
      reportError(error);
    } finally {
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
          <SectionTitle icon={<KeyRound size={16} />} title="AI 服务配置" />
          <div className="configPath">{configPath || "配置文件尚未加载"}</div>
          <textarea
            className="configEditor"
            value={configContent}
            onChange={(event) => setConfigContent(event.target.value)}
            spellCheck={false}
          />
          <div className="providerActions">
            <button
              className="commandButton"
              disabled={isSavingConfig || !configContent.trim()}
              onClick={() => void saveConfig()}
            >
              {isSavingConfig ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
              保存并加载
            </button>
            <button
              className="iconTextButton"
              onClick={() => void reloadProviderConfig()}
            >
              <RefreshCw size={16} />
              重新加载
            </button>
          </div>
          <div className="stackList providerList">
            {providers.map((provider) => (
              <button
                key={provider.id}
                className={`listRow ${
                  provider.id === selectedProviderId ? "active" : ""
                }`}
                onClick={() => {
                  setSelectedProviderId(provider.id);
                  if (selectedSession?.providerId !== provider.id) {
                    setSelectedSessionId("");
                    setEventsResponse(EMPTY_EVENTS);
                  }
                }}
              >
                <KeyRound size={15} />
                <span>
                  <strong>{provider.name}</strong>
                  <small>{provider.id}</small>
                </span>
              </button>
            ))}
            {!providers.length && <EmptyLine text="JSON 中还没有可用服务" />}
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
              <TimelineEvent key={event.id} event={event} />
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
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
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

function TimelineEvent({ event }: { event: EventRecord }) {
  return (
    <article className={`timelineEvent ${eventTone(event.type)}`}>
      <div className="eventIcon">{eventIcon(event.type)}</div>
      <div className="eventBody">
        <header>
          <strong>{eventLabel(event)}</strong>
          <span>#{event.seq}</span>
        </header>
        <EventDetail event={event} />
      </div>
    </article>
  );
}

function EventDetail({ event }: { event: EventRecord }) {
  if (event.type === "prompt.submitted") {
    return <p>{valueAsString(event.data.prompt)}</p>;
  }
  if (event.type === "assistant.message" || event.type === "reasoning.summary") {
    return <p>{valueAsString(event.data.text)}</p>;
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

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
