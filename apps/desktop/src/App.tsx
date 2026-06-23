import {
  AlertTriangle,
  ArrowUp,
  Bot,
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Database,
  FileCode2,
  FolderOpen,
  History,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  approveToolCall,
  cancelJob,
  cancelSession,
  compactSession,
  continueSession,
  createSession,
  deleteSession,
  fetchProjectFiles,
  getSessionEvents,
  tailSessionEvents,
  listSessions,
  loadShellPolicy,
  loadProviderConfig,
  pickProjectDirectory,
  rejectToolCall,
  replyPermission,
  rollbackSnapshot,
  saveProviderConfig,
  saveShellPolicy,
  promptSession,
  updateSessionMode,
  updateSessionTitle,
  type AgentMode,
  type EventRecord,
  type PermissionRequestRecord,
  type PermissionReply,
  type PromptAttachmentInput,
  type ProjectFile,
  type ProviderConfigFileResponse,
  type ProviderRecord,
  type SessionEventsResponse,
  type SessionRecord,
  type ShellPolicy,
  type ShellMode,
  type SnapshotRecord
} from "./api";
import {
  EMPTY_SESSION_EVENTS as EMPTY_EVENTS,
  currentSessionEvents,
  mergeSessionEvents,
  type ODotRealtimeEvent,
  useSessionEventStore
} from "./sessionStore";

const MAX_TEXT_ATTACHMENT_BYTES = 250_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

type Notice = {
  tone: "info" | "success" | "error";
  text: string;
};

type ThemeMode = "system" | "light" | "dark";
type PromptAttachmentKind = "text" | "image";

type PromptAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: PromptAttachmentKind;
  content: string;
};

type PromptAttachmentSummary = Omit<PromptAttachmentInput, "content">;

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
  const eventsResponse = useSessionEventStore((state) => state.eventsResponse);
  const setEventsResponse = useSessionEventStore(
    (state) => state.setEventsResponse
  );
  const applyRealtimeEvent = useSessionEventStore(
    (state) => state.applyRealtimeEvent
  );
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<string>>(new Set());
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
  const [isContinuing, setIsContinuing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("odot.themeMode");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const realtimeTailTimerRef = useRef<number | undefined>(undefined);
  const activeRunIdRef = useRef(0);
  const stopBaselineSeqRef = useRef(0);
  const rollbackInFlightRef = useRef(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [promptAttachments, setPromptAttachments] = useState<PromptAttachment[]>([]);
  const [leftWidth, setLeftWidth] = useState(() => {
    const stored = Number(localStorage.getItem("odot.leftWidth"));
    return Number.isFinite(stored) && stored >= 300 ? stored : 420;
  });
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(false);

  useEffect(() => {
    void bootstrap();
    return () => {
      if (realtimeTailTimerRef.current) {
        window.clearTimeout(realtimeTailTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("odot.leftWidth", String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    localStorage.setItem("odot.themeMode", themeMode);
  }, [themeMode]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme(mode: ThemeMode) {
      const resolvedTheme = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
    }

    applyTheme(themeMode);
    const onChange = () => applyTheme(themeMode);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode]);

  useEffect(() => {
    function syncRightPaneByViewport() {
      if (window.innerWidth < 1000) {
        setIsRightPaneCollapsed(true);
      }
    }

    syncRightPaneByViewport();
    window.addEventListener("resize", syncRightPaneByViewport);
    return () => window.removeEventListener("resize", syncRightPaneByViewport);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ODotRealtimeEvent>("odot:event", ({ payload }) => {
      if (disposed || payload.sessionId !== selectedSessionId) {
        return;
      }
      applyRealtimeEvent(payload);
      if (payload.event) {
        scheduleRealtimeTailRefresh(payload.sessionId);
      }
      if (
        payload.event?.type === "agent.stopped" &&
        payload.event.seq > stopBaselineSeqRef.current
      ) {
        setIsStopping(false);
        setNotice({ tone: "success", text: "Agent 已停止" });
      }
      if (payload.kind === "session.start" || payload.kind === "task.completed") {
        void refreshSessions().catch(() => undefined);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [selectedSessionId, applyRealtimeEvent]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId]
  );
  const selectedModelLabel = selectedProvider
    ? providerModelLabel(selectedProvider)
    : "未选择模型";
  const allowedAttachmentKinds = useMemo(
    () => attachmentKindsFromConfig(configContent, selectedProviderId),
    [configContent, selectedProviderId]
  );
  const attachmentAccept = useMemo(
    () => attachmentAcceptValue(allowedAttachmentKinds),
    [allowedAttachmentKinds]
  );
  const canUploadAttachments = allowedAttachmentKinds.length > 0;

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

  useEffect(() => {
    if (
      selectedSessionId &&
      !availableSessions.some((session) => session.id === selectedSessionId)
    ) {
      setSelectedSessionId("");
      setEventsResponse(EMPTY_EVENTS);
      setStreamingEventId(null);
    }
  }, [availableSessions, selectedSessionId]);

  useEffect(() => {
    if (!providers.length) {
      if (selectedProviderId) {
        setSelectedProviderId("");
      }
      return;
    }
    if (
      !selectedProviderId ||
      !providers.some((provider) => provider.id === selectedProviderId)
    ) {
      const preferredProviderId = preferredConfigProviderId({
        providers,
        selectedProviderId: null,
        path: "",
        content: configContent
      });
      setSelectedProviderId(preferredProviderId);
    }
  }, [configContent, providers, selectedProviderId]);

  useEffect(() => {
    setPromptAttachments((current) =>
      current.filter((attachment) => allowedAttachmentKinds.includes(attachment.kind))
    );
  }, [allowedAttachmentKinds]);

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

  const visibleJobs = useMemo(
    () =>
      eventsResponse.jobs.filter(
        (job) => job.status !== "cancelled" && !dismissedJobIds.has(job.id)
      ),
    [dismissedJobIds, eventsResponse.jobs]
  );

  const contextUsage = useMemo(
    () =>
      contextUsageFromEvents(eventsResponse) ??
      estimateContextUsage({
        eventsResponse,
        configContent,
        selectedProviderId,
        draftPrompt: prompt
      }),
    [configContent, eventsResponse, prompt, selectedProviderId]
  );

  const latestExecutablePlanEvent = useMemo(() => {
    if (selectedSession?.mode !== "plan") {
      return null;
    }
    return (
      [...eventsResponse.events]
        .reverse()
        .find(
          (event) =>
            event.type === "assistant.message" &&
            valueAsString(event.data.text).trim()
        ) ?? null
    );
  }, [eventsResponse.events, selectedSession?.mode]);
  const planExecutionEvents = useMemo(
    () => latestPlanExecutionEvents(eventsResponse.events),
    [eventsResponse.events]
  );

  const latestEventId = eventsResponse.events.at(-1)?.id ?? "";
  const promptEventCount = useMemo(
    () => eventsResponse.events.filter((event) => event.type === "prompt.submitted").length,
    [eventsResponse.events]
  );
  const isAgentWorking = isSubmitting || isContinuing;
  const isPromptLocked = isAgentWorking || isStopping || pendingToolEvents.length > 0;

  useLayoutEffect(() => {
    timelineEndRef.current?.scrollIntoView({ block: "end" });
  }, [latestEventId, streamingEventId]);

  useLayoutEffect(() => {
    const input = promptInputRef.current;
    if (!input) {
      return;
    }

    input.style.height = "auto";
    const computed = window.getComputedStyle(input);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 22;
    const padding =
      (Number.parseFloat(computed.paddingTop) || 0) +
      (Number.parseFloat(computed.paddingBottom) || 0);
    const maxHeight = lineHeight * 4 + padding;
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [prompt, isPromptLocked]);

  useEffect(() => {
    if (!isModelMenuOpen) {
      return;
    }

    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsModelMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isModelMenuOpen]);

  useEffect(() => {
    if (isPromptLocked || selectedSessionId) {
      setIsModelMenuOpen(false);
    }
  }, [isPromptLocked, selectedSessionId]);

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
      const restorableSession = nextSessions.find((session) =>
        config.providers.some((provider) => provider.id === session.providerId)
      );
      if (restorableSession) {
        await selectSession(restorableSession);
      } else {
        setSelectedSessionId("");
        setEventsResponse(EMPTY_EVENTS);
        setStreamingEventId(null);
      }
      setNotice({ tone: "success", text: "工作区已加载" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsBooting(false);
    }
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

  async function loadEventTail(sessionId: string) {
    const afterSeq = currentSessionEvents().events.at(-1)?.seq ?? 0;
    const response = await tailSessionEvents({ sessionId, afterSeq });
    setEventsResponse((current) => mergeSessionEvents(current, response));
    return response;
  }

  function applyEventRecord(event: EventRecord) {
    applyRealtimeEvent({
      version: 1,
      kind: event.type,
      sessionId: event.sessionId,
      seq: event.seq,
      event
    });
  }

  function scheduleRealtimeTailRefresh(sessionId: string) {
    if (realtimeTailTimerRef.current) {
      window.clearTimeout(realtimeTailTimerRef.current);
    }
    realtimeTailTimerRef.current = window.setTimeout(() => {
      realtimeTailTimerRef.current = undefined;
      void loadEventTail(sessionId).catch(() => undefined);
    }, 100);
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
    if (selectedSession) {
      if (selectedSession.mode !== mode || selectedSession.shellMode !== shellMode) {
        const updated = await updateSessionMode({
          sessionId: selectedSession.id,
          mode,
          shellMode
        });
        setSessions((current) =>
          current.map((session) => (session.id === updated.id ? updated : session))
        );
        return updated;
      }
      return selectedSession;
    }

    setSelectedSessionId("");
    setEventsResponse(EMPTY_EVENTS);
    return createCurrentSession();
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
      setEventsResponse(EMPTY_EVENTS);
      return session;
    } catch (error) {
      reportError(error);
      throw error;
    } finally {
      setIsCreatingSession(false);
    }
  }

  async function handleAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selectedFiles.length) {
      return;
    }
    try {
      const nextAttachments = await Promise.all(
        selectedFiles.map((file) => readPromptAttachment(file, allowedAttachmentKinds))
      );
      setPromptAttachments((current) => [...current, ...nextAttachments]);
      setNotice({
        tone: "success",
        text: `已添加 ${nextAttachments.length} 个附件`
      });
    } catch (error) {
      reportError(error);
    }
  }

  function removePromptAttachment(id: string) {
    setPromptAttachments((current) =>
      current.filter((attachment) => attachment.id !== id)
    );
  }

  async function handleSubmitPrompt() {
    if ((!prompt.trim() && !promptAttachments.length) || isPromptLocked) {
      return;
    }
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsSubmitting(true);
    setNotice({ tone: "info", text: "Agent 正在工作" });
    try {
      const session = await ensureSession();
      const previousMaxSeq = eventsResponse.events.at(-1)?.seq ?? 0;
      const selectedFileText = Array.from(selectedPaths).sort().join("\n");
      const finalPrompt = selectedFileText
        ? `${prompt.trim() || "请根据附件内容继续。"}\n\n已选择文件:\n${selectedFileText}`
        : prompt;
      const response = await promptSession({
        sessionId: session.id,
        prompt: finalPrompt,
        attachments: promptAttachments.map(toPromptAttachmentInput),
        delivery: "queue",
        resume: true
      });
      if (activeRunIdRef.current !== runId) {
        return;
      }
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
      setPromptAttachments([]);
      setNotice({
        tone: "success",
        text: hasUnresolvedPendingTools(response.events)
          ? "等待命令确认"
          : "Agent 已结束"
      });
    } catch (error) {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      reportError(error);
      if (selectedSessionId) {
        await loadEvents(selectedSessionId).catch(() => undefined);
      }
    } finally {
      if (activeRunIdRef.current === runId) {
        setIsSubmitting(false);
      }
    }
  }

  async function handleExecutePlan(planEvent: EventRecord) {
    if (!selectedSession || isPromptLocked) {
      return;
    }

    const planText = valueAsString(planEvent.data.text).trim();
    if (!planText) {
      setNotice({ tone: "error", text: "没有可执行的计划内容" });
      return;
    }

    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsSubmitting(true);
    setNotice({ tone: "info", text: "正在执行计划" });
    try {
      const executionSession = await updateSessionMode({
        sessionId: selectedSession.id,
        mode: "agent"
      });
      setMode("agent");
      setSessions((current) =>
        current.map((session) =>
          session.id === executionSession.id ? executionSession : session
        )
      );

      const response = await promptSession({
        sessionId: executionSession.id,
        prompt: buildPlanExecutionPrompt(planText),
        delivery: "queue",
        resume: true
      });
      if (activeRunIdRef.current !== runId) {
        return;
      }
      const latestAssistantEvent = [...response.events]
        .reverse()
        .find((event) => event.type === "assistant.message");
      setEventsResponse(response);
      setStreamingEventId(latestAssistantEvent?.id ?? null);
      await refreshSessions();
      setNotice({
        tone: "success",
        text: hasUnresolvedPendingTools(response.events)
          ? "等待命令确认"
          : "计划执行已结束"
      });
    } catch (error) {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      reportError(error);
    } finally {
      if (activeRunIdRef.current === runId) {
        setIsSubmitting(false);
      }
    }
  }

  async function handleStopAgent() {
    const sessionId = selectedSessionId;
    const baselineSeq = eventsResponse.events.at(-1)?.seq ?? 0;
    stopBaselineSeqRef.current = baselineSeq;
    activeRunIdRef.current += 1;
    setIsSubmitting(false);
    setIsContinuing(false);
    setIsStopping(true);
    setNotice({ tone: "info", text: "正在停止 Agent" });
    if (!sessionId) {
      setIsStopping(false);
      return;
    }
    try {
      const event = await cancelSession(sessionId);
      applyEventRecord(event);
      if (
        event.type === "agent.stopped" &&
        event.seq > stopBaselineSeqRef.current
      ) {
        setIsStopping(false);
        setNotice({ tone: "success", text: "Agent 已停止" });
      }
    } catch (error) {
      setIsStopping(false);
      reportError(error);
    }
  }

  async function handleApprove(eventId: string) {
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsMutating(true);
    setIsContinuing(true);
    setNotice({ tone: "info", text: "Agent 正在继续" });
    try {
      const sessionId = selectedSessionId;
      const approvedEvent = await approveToolCall(eventId);
      if (sessionId) {
        const response = await continueSession(sessionId);
        if (activeRunIdRef.current !== runId) {
          return;
        }
        setEventsResponse(response);
        setNotice({
          tone: "success",
          text: hasUnresolvedPendingTools(response.events)
            ? "等待命令确认"
            : "Agent 已结束"
        });
      } else {
        applyEventRecord(approvedEvent);
        setNotice({ tone: "success", text: "命令已批准" });
      }
    } catch (error) {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      reportError(error);
    } finally {
      if (activeRunIdRef.current === runId) {
        setIsContinuing(false);
        setIsMutating(false);
      }
    }
  }

  async function handleApproveAndAllow(event: EventRecord) {
    const command = pendingCommand(event).trim();
    if (!command) {
      return;
    }
    const allowlistPrefix = shellAllowlistPrefix(command);

    setIsMutating(true);
    try {
      const nextPolicy = {
        autoAllowlist: Array.from(
          new Set([...shellPolicy.autoAllowlist, allowlistPrefix])
        )
      };
      const savedPolicy = await saveShellPolicy(nextPolicy);
      setShellPolicy(savedPolicy);
      await handleApprove(event.id);
    } catch (error) {
      reportError(error);
      setIsMutating(false);
    }
  }

  async function handleReject(eventId: string) {
    setIsMutating(true);
    try {
      const event = await rejectToolCall(eventId);
      applyEventRecord(event);
      setNotice({ tone: "success", text: "命令已拒绝" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handlePermissionReply(requestId: string, reply: PermissionReply) {
    setIsMutating(true);
    try {
      const permission = await replyPermission({ requestId, reply });
      applyRealtimeEvent({
        version: 1,
        kind: "permission.answered",
        sessionId: permission.sessionId,
        seq: 0,
        permission
      });
      setNotice({ tone: reply === "reject" ? "error" : "success", text: "权限已处理" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleCancelJob(jobId: string) {
    const job = eventsResponse.jobs.find((item) => item.id === jobId);
    setIsMutating(true);
    setDismissedJobIds((current) => new Set(current).add(jobId));
    setEventsResponse((current) => ({
      ...current,
      jobs: current.jobs.filter((item) => item.id !== jobId)
    }));
    try {
      await cancelJob(jobId);
      setNotice({ tone: "success", text: "后台任务已停止" });
    } catch (error) {
      setDismissedJobIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      if (job) {
        setEventsResponse((current) => ({
          ...current,
          jobs: current.jobs.some((item) => item.id === jobId)
            ? current.jobs
            : [job, ...current.jobs]
        }));
      }
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleRollback(snapshotId: string) {
    await handleRollbackMany([snapshotId], "快照已回滚");
  }

  async function handleRollbackMany(snapshotIds: string[], successText: string) {
    if (rollbackInFlightRef.current) {
      return;
    }
    if (!snapshotIds.length) {
      setNotice({ tone: "info", text: "没有可回滚的代码变更" });
      return;
    }
    rollbackInFlightRef.current = true;
    setIsMutating(true);
    try {
      for (const snapshotId of snapshotIds) {
        await rollbackSnapshot(snapshotId);
      }
      if (selectedSessionId) {
        scheduleRealtimeTailRefresh(selectedSessionId);
      }
      await loadFiles(projectRoot);
      setNotice({ tone: "success", text: successText });
    } catch (error) {
      reportError(error);
    } finally {
      rollbackInFlightRef.current = false;
      setIsMutating(false);
    }
  }

  async function handleCompact() {
    if (!selectedSessionId) {
      return;
    }
    setIsMutating(true);
    try {
      const summary = await compactSession(selectedSessionId);
      applyRealtimeEvent({
        version: 1,
        kind: "context.summary.created",
        sessionId: summary.sessionId,
        seq: summary.recentEventSeq,
        summary
      });
      scheduleRealtimeTailRefresh(selectedSessionId);
      setNotice({ tone: "success", text: "上下文已压缩" });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  function scrollToPrompt(direction: "previous" | "next") {
    const container = timelineScrollRef.current;
    if (!container) {
      return;
    }
    const promptBlocks = Array.from(
      container.querySelectorAll<HTMLElement>("[data-prompt-block='true']")
    );
    if (!promptBlocks.length) {
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const currentTop = container.scrollTop;
    const promptPositions = promptBlocks.map((element) => ({
      element,
      top: element.getBoundingClientRect().top - containerTop + currentTop
    }));
    const threshold = currentTop + 24;
    const target =
      direction === "previous"
        ? [...promptPositions].reverse().find((item) => item.top < threshold - 48) ??
          promptPositions[0]
        : promptPositions.find((item) => item.top > threshold) ??
          promptPositions[promptPositions.length - 1];

    container.scrollTo({
      top: Math.max(0, target.top - 12),
      behavior: "smooth"
    });
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

  function startEditingSession(session: SessionRecord) {
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  }

  function cancelEditingSession() {
    setEditingSessionId(null);
    setEditingSessionTitle("");
  }

  async function saveSessionTitle(sessionId: string) {
    const title = editingSessionTitle.trim();
    if (!title) {
      setNotice({ tone: "error", text: "会话标题不能为空" });
      return;
    }

    setIsMutating(true);
    try {
      await updateSessionTitle({ sessionId, title });
      await refreshSessions();
      cancelEditingSession();
      setNotice({ tone: "success", text: "会话标题已更新" });
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
        gridTemplateColumns: `${leftWidth}px 6px minmax(0, 1fr) ${isRightPaneCollapsed ? 44 : 344}px`
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
              isCreatingSession ||
              isAgentWorking ||
              !selectedProviderId ||
              !projectRoot.trim()
            }
            onClick={() => void createCurrentSession().catch(() => undefined)}
          >
            {isCreatingSession ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            新建会话
          </button>
          <div className="stackList">
            {availableSessions.map((session) => (
              <div
                key={session.id}
                className={`listRow ${
                  session.id === selectedSessionId ? "active" : ""
                }`}
              >
                <Clock3 size={15} />
                {editingSessionId === session.id ? (
                  <input
                    className="sessionTitleInput"
                    value={editingSessionTitle}
                    autoFocus
                    onChange={(event) => setEditingSessionTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveSessionTitle(session.id);
                      }
                      if (event.key === "Escape") {
                        cancelEditingSession();
                      }
                    }}
                    onBlur={() => void saveSessionTitle(session.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="sessionSelectButton"
                    disabled={isAgentWorking}
                    onClick={() => void selectSession(session)}
                    onDoubleClick={() => startEditingSession(session)}
                  >
                    <strong>{session.title}</strong>
                    <small>
                      {modeLabel(session.mode)} / {shellModeLabel(session.shellMode)}
                    </small>
                  </button>
                )}
                <button
                  type="button"
                  className="rowIconAction"
                  aria-label={`重命名会话 ${session.title}`}
                  disabled={editingSessionId === session.id || isMutating || isAgentWorking}
                  onClick={() => startEditingSession(session)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="rowIconAction danger"
                  aria-label={`删除会话 ${session.title}`}
                  disabled={isMutating || isAgentWorking}
                  onClick={() => void handleDeleteSession(session.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
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
              onChange={(value) => {
                const nextMode = value as AgentMode;
                setMode(nextMode);
                if (selectedSessionId) {
                  void updateSessionMode({ sessionId: selectedSessionId, mode: nextMode })
                    .then((updated) =>
                      setSessions((current) =>
                        current.map((s) => s.id === updated.id ? updated : s)
                      )
                    )
                    .catch(reportError);
                }
              }}
            />
          </div>
          <div className={`notice ${notice.tone}`}>
            {(isBooting || isAgentWorking || isStopping) && (
              <Loader2 className="spin" size={15} />
            )}
            <span>{notice.text}</span>
          </div>
        </header>

        <section className="timelinePane">
          <div className="paneHeader">
            <div>
              <ContextUsageMeter usage={contextUsage} />
              <strong>{selectedSession?.title ?? "暂无活动会话"}</strong>
              <small>
                {selectedProvider ? selectedModelLabel : "未选择服务"} / 已选 {selectedPaths.size} 个文件
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

          <div className="timeline" ref={timelineScrollRef}>
            <ConversationTimeline
              events={eventsResponse.events}
              snapshots={eventsResponse.snapshots}
              streamingEventId={streamingEventId ?? ""}
              executablePlanEventId={latestExecutablePlanEvent?.id ?? ""}
              canExecutePlan={!isPromptLocked && !isMutating}
              onExecutePlan={handleExecutePlan}
              rollbackDisabled={isMutating}
              onRollbackSnapshot={(snapshotId) => void handleRollback(snapshotId)}
              onRollbackSnapshots={(snapshotIds, successText) =>
                void handleRollbackMany(snapshotIds, successText ?? "已回滚到提示词发送前")
              }
            />
            {!eventsResponse.events.length && (
              <div className="emptyTimeline">
                <BrainCircuit size={28} />
                <span>输入提示词开始</span>
              </div>
            )}
            <div ref={timelineEndRef} />
          </div>

          {planExecutionEvents.length > 0 && (
            <PlanExecutionDock
              events={planExecutionEvents}
              snapshots={eventsResponse.snapshots}
            />
          )}

          <div className="promptBar">
            <div className="promptComposer">
              <input
                ref={attachmentInputRef}
                className="promptAttachmentInput"
                type="file"
                multiple
                accept={attachmentAccept}
                onChange={(event) => void handleAttachmentInputChange(event)}
              />
              <textarea
                ref={promptInputRef}
                className="promptInput"
                rows={1}
                value={prompt}
                disabled={isPromptLocked}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  isAgentWorking
                    ? "Agent 正在工作，结束后才能继续发送。"
                    : isStopping
                      ? "Agent 正在停止，确认截断后才能继续发送。"
                    : pendingToolEvents.length
                      ? "请先处理待确认命令。"
                      : "要求后续变更"
                }
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
              {promptAttachments.length > 0 && (
                <div className="promptAttachmentList" aria-label="已上传附件">
                  {promptAttachments.map((attachment) => (
                    <span className="promptAttachmentChip" key={attachment.id}>
                      <span>{attachment.name}</span>
                      <small>
                        {attachment.kind === "image" ? "图片" : "文本"} ·{" "}
                        {formatBytes(attachment.size)}
                      </small>
                      <button
                        type="button"
                        aria-label={`移除附件 ${attachment.name}`}
                        disabled={isPromptLocked}
                        onClick={() => removePromptAttachment(attachment.id)}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="promptActionRow">
                <div className="composerControls">
                  <button
                    type="button"
                    className="composerAttachButton"
                    title={
                      selectedProviderId
                        ? attachmentUploadTitle(allowedAttachmentKinds)
                        : "请先选择模型"
                    }
                    aria-label="上传附件"
                    disabled={isPromptLocked || !selectedProviderId || !canUploadAttachments}
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    <Plus size={18} />
                  </button>
                  <div
                    ref={modelMenuRef}
                    className="composerModelSelect"
                    title={
                      selectedSessionId
                        ? "当前会话已绑定模型，新会话前可切换"
                        : "选择模型"
                    }
                  >
                    <button
                      type="button"
                      className="composerModelButton"
                      disabled={isPromptLocked || Boolean(selectedSessionId)}
                      aria-haspopup="listbox"
                      aria-expanded={isModelMenuOpen}
                      aria-label="选择模型"
                      onClick={() => setIsModelMenuOpen((open) => !open)}
                    >
                      <span>{selectedProvider ? selectedModelLabel : "未配置模型"}</span>
                      <ChevronDown size={15} />
                    </button>
                    {isModelMenuOpen && !isPromptLocked && !selectedSessionId && (
                      <div className="composerModelMenu" role="listbox" aria-label="选择模型">
                        {!providers.length && (
                          <div className="composerModelEmpty">未配置模型</div>
                        )}
                        {providers.map((provider) => {
                          const isSelected = provider.id === selectedProviderId;
                          return (
                            <button
                              type="button"
                              key={provider.id}
                              className={`composerModelOption ${isSelected ? "active" : ""}`}
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => {
                                setSelectedProviderId(provider.id);
                                setIsModelMenuOpen(false);
                              }}
                            >
                              <span>{providerModelLabel(provider)}</span>
                              {isSelected && <Check size={15} />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <Segmented
                    className="composerShellMode"
                    value={shellMode}
                    disabled={isPromptLocked}
                    options={[
                      ["manual", "手动"],
                      ["auto", "自动"]
                    ]}
                    onChange={(value) => {
                      const nextShellMode = value as ShellMode;
                      setShellMode(nextShellMode);
                      if (selectedSessionId) {
                        void updateSessionMode({
                          sessionId: selectedSessionId,
                          shellMode: nextShellMode
                        })
                          .then((updated) =>
                            setSessions((current) =>
                              current.map((s) => (s.id === updated.id ? updated : s))
                            )
                          )
                          .catch(reportError);
                      }
                    }}
                  />
                  <div className="promptNavGroup">
                    <button
                      type="button"
                      className="promptNavIconButton"
                      title="上一条提示词"
                      aria-label="上一条提示词"
                      disabled={!promptEventCount}
                      onClick={() => scrollToPrompt("previous")}
                    >
                      <ChevronUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="promptNavIconButton"
                      title="下一条提示词"
                      aria-label="下一条提示词"
                      disabled={!promptEventCount}
                      onClick={() => scrollToPrompt("next")}
                    >
                      <ChevronDown size={16} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className={`composerSendButton ${isAgentWorking ? "stop" : ""}`}
                  aria-label={isAgentWorking ? "停止 Agent" : "发送提示词"}
                  disabled={
                    isAgentWorking
                      ? false
                      : (!prompt.trim() && !promptAttachments.length) ||
                        isPromptLocked ||
                        !selectedProviderId
                  }
                  onClick={() =>
                    isAgentWorking
                      ? void handleStopAgent()
                      : void handleSubmitPrompt()
                  }
                >
                  {isAgentWorking ? <Square size={17} /> : <ArrowUp size={19} />}
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <aside className={`rightPane ${isRightPaneCollapsed ? "collapsed" : ""}`}>
        <button
          className="rightPaneToggle"
          type="button"
          aria-label={isRightPaneCollapsed ? "展开右侧面板" : "折叠右侧面板"}
          onClick={() => setIsRightPaneCollapsed((current) => !current)}
        >
          {isRightPaneCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>

        {!isRightPaneCollapsed && (
          <>
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
                    title="接受"
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="iconButton trust"
                    disabled={isMutating}
                    onClick={() => void handleApproveAndAllow(event)}
                    title="接受并加入白名单"
                  >
                    <Save size={16} />
                  </button>
                  <button
                    className="iconButton danger"
                    disabled={isMutating}
                    onClick={() => void handleReject(event.id)}
                    title="拒绝"
                  >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {!pendingToolEvents.length && <EmptyLine text="暂无待确认命令" />}
              </div>
            </section>

            <section className="rightSection">
              <SectionTitle icon={<KeyRound size={16} />} title="权限请求" />
              <div className="stackList">
                {visiblePermissionRequests(eventsResponse.permissions)
                  .map((request) => (
                    <div className="approvalRow" key={request.id}>
                      <code>{request.action}: {request.resources.join(", ")}</code>
                      <div>
                        <button
                          className="iconButton success"
                          disabled={isMutating}
                          onClick={() => void handlePermissionReply(request.id, "once")}
                          title="本次允许"
                        >
                          <Check size={16} />
                        </button>
                        <button
                          className="iconButton trust"
                          disabled={isMutating}
                          onClick={() => void handlePermissionReply(request.id, "always")}
                          title="总是允许"
                        >
                          <Save size={16} />
                        </button>
                        <button
                          className="iconButton danger"
                          disabled={isMutating}
                          onClick={() => void handlePermissionReply(request.id, "reject")}
                          title="拒绝"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                {!visiblePermissionRequests(eventsResponse.permissions).length && (
                  <EmptyLine text="暂无权限请求" />
                )}
              </div>
            </section>

            <section className="rightSection">
              <SectionTitle icon={<Clock3 size={16} />} title="后台任务" />
              <div className="stackList">
                {visibleJobs.map((job) => (
                  <div className="approvalRow" key={job.id}>
                    <code>{job.status} #{job.pid} {job.command}</code>
                    <button
                      className="iconButton danger"
                      disabled={isMutating || job.status !== "running"}
                      onClick={() => void handleCancelJob(job.id)}
                      title="停止任务"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                {!visibleJobs.length && <EmptyLine text="暂无后台任务" />}
              </div>
            </section>

          </>
        )}
      </aside>

      {isSettingsOpen && (
        <SettingsModal
          configPath={configPath}
          configContent={configContent}
          providers={providers}
          selectedProviderId={selectedProviderId}
          shellPolicy={shellPolicy}
          themeMode={themeMode}
          isSaving={isSavingConfig}
          onThemeModeChange={setThemeMode}
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
  themeMode,
  isSaving,
  onThemeModeChange,
  onClose,
  onSave
}: {
  configPath: string;
  configContent: string;
  providers: ProviderRecord[];
  selectedProviderId: string;
  shellPolicy: ShellPolicy;
  themeMode: ThemeMode;
  isSaving: boolean;
  onThemeModeChange: (mode: ThemeMode) => void;
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
              <span>主题模式</span>
              <Segmented
                value={themeMode}
                options={[
                  ["system", "跟随系统"],
                  ["light", "浅色"],
                  ["dark", "深色"]
                ]}
                onChange={(value) => onThemeModeChange(value as ThemeMode)}
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

type TimelineItemKind =
  | "userPrompt"
  | "assistantReply"
  | "reasoning"
  | "codeChange"
  | "codeChangeSummary"
  | "statusSummary"
  | "hiddenDetail";

type TimelineStatus = "done" | "running" | "waiting" | "failed" | "neutral";

type TimelineCodeChange = {
  id: string;
  snapshotId?: string;
  snapshotIds?: string[];
  path: string;
  operation: string;
  patch: string;
  stats: { added: number; deleted: number };
  beforeContent?: string | null;
  afterContent?: string | null;
  order?: number;
  createdAt?: string;
};

type TimelineCodeChangeGroup = {
  id: string;
  promptEventId?: string;
  changes: TimelineCodeChange[];
  stats: { files: number; added: number; deleted: number };
  rollbackSnapshotIds: string[];
};

type TimelineItem = {
  id: string;
  kind: TimelineItemKind;
  title: string;
  text?: string;
  attachments?: PromptAttachmentSummary[];
  status: TimelineStatus;
  event?: EventRecord;
  details: EventRecord[];
  hiddenSummary?: string;
  codeChange?: TimelineCodeChange;
  codeChangeGroup?: TimelineCodeChangeGroup;
  rollbackSnapshotIds?: string[];
};

function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const tooltipId = "context-usage-details";
  return (
    <div
      className={`contextUsage ${usage.severity}`}
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      <span>
        上下文 {usage.percent}% · {usage.source === "provider" ? "实际" : "估算"}
      </span>
      <div className="contextTrack" aria-hidden="true">
        <i style={{ width: `${usage.barPercent}%` }} />
      </div>
      <div className="contextUsagePopover" id={tooltipId} role="tooltip">
        <header>
          <strong>{formatInteger(usage.usedTokens)} tokens</strong>
          <span>
            / {formatInteger(usage.maxTokens)} · {usage.percent}%
          </span>
        </header>
        <dl>
          <div>
            <dt>输入</dt>
            <dd>{formatInteger(usage.tokens.input)}</dd>
          </div>
          <div>
            <dt>输出</dt>
            <dd>{formatInteger(usage.tokens.output)}</dd>
          </div>
          <div>
            <dt>推理</dt>
            <dd>{formatInteger(usage.tokens.reasoning)}</dd>
          </div>
          <div>
            <dt>缓存读取</dt>
            <dd>{formatInteger(usage.tokens.cache.read)}</dd>
          </div>
          <div>
            <dt>缓存写入</dt>
            <dd>{formatInteger(usage.tokens.cache.write)}</dd>
          </div>
          <div>
            <dt>总量</dt>
            <dd>{formatInteger(usage.tokens.total)}</dd>
          </div>
        </dl>
        <p>
          {usage.providerId || "未知 Provider"} / {usage.model || "未知模型"}
          {usage.step ? ` / step ${usage.step}` : ""}
        </p>
        {usage.notes.map((note) => (
          <p className="contextUsageNote" key={note}>
            {note}
          </p>
        ))}
      </div>
    </div>
  );
}

function ConversationTimeline({
  events,
  snapshots,
  streamingEventId,
  executablePlanEventId,
  canExecutePlan,
  onExecutePlan,
  rollbackDisabled,
  onRollbackSnapshot,
  onRollbackSnapshots
}: {
  events: EventRecord[];
  snapshots: SnapshotRecord[];
  streamingEventId: string;
  executablePlanEventId: string;
  canExecutePlan: boolean;
  onExecutePlan: (event: EventRecord) => Promise<void>;
  rollbackDisabled: boolean;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRollbackSnapshots: (snapshotIds: string[], successText?: string) => void;
}) {
  const items = useMemo(
    () => buildTimelineItems(events, snapshots),
    [events, snapshots]
  );

  return (
    <>
      {items.map((item) => (
        <TimelineItemView
          key={item.id}
          item={item}
          stream={item.event?.id === streamingEventId}
          canExecutePlan={
            canExecutePlan &&
            item.kind === "assistantReply" &&
            item.event?.id === executablePlanEventId
          }
          onExecutePlan={onExecutePlan}
          rollbackDisabled={rollbackDisabled}
          onRollbackSnapshot={onRollbackSnapshot}
          onRollbackSnapshots={onRollbackSnapshots}
        />
      ))}
    </>
  );
}

function TimelineItemView({
  item,
  stream,
  canExecutePlan,
  onExecutePlan,
  rollbackDisabled,
  onRollbackSnapshot,
  onRollbackSnapshots
}: {
  item: TimelineItem;
  stream: boolean;
  canExecutePlan: boolean;
  onExecutePlan: (event: EventRecord) => Promise<void>;
  rollbackDisabled: boolean;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRollbackSnapshots: (snapshotIds: string[], successText?: string) => void;
}) {
  const hiddenDetails = item.details.filter((event) => event.id !== item.event?.id);
  const icon = timelineItemIcon(item);

  return (
    <article
      className={`timelineItem ${item.kind} ${item.status}`}
      data-prompt-block={item.kind === "userPrompt" ? "true" : undefined}
    >
      <div className="timelineItemRail">
        <div className="timelineItemIcon">{icon}</div>
      </div>
      <div className="timelineItemBody">
        <header className="timelineItemHeader">
          <strong>{item.title}</strong>
          {item.event && <span>#{item.event.seq}</span>}
        </header>

        {item.kind === "userPrompt" && (
          <>
            {item.text && <p className="promptText">{item.text}</p>}
            {!!item.attachments?.length && (
              <div className="timelineAttachmentList" aria-label="提示词附件">
                {item.attachments.map((attachment, index) => (
                  <span className="timelineAttachmentChip" key={`${item.id}-${index}-${attachment.name}`}>
                    {attachment.name}
                    <small>
                      {attachment.kind === "image" ? "图片" : "文本"} · {formatBytes(attachment.size)}
                    </small>
                  </span>
                ))}
              </div>
            )}
            <div className="timelineItemActions">
              <button
                type="button"
                className="inlineRollbackButton"
                disabled={rollbackDisabled || !item.rollbackSnapshotIds?.length}
                onClick={() => onRollbackSnapshots(item.rollbackSnapshotIds ?? [])}
                title="回滚到这条提示词发送之前"
              >
                <RotateCcw size={15} />
                回滚到发送前
              </button>
            </div>
          </>
        )}

        {item.kind === "assistantReply" && (
          <div className="assistantDetail">
            <MarkdownText text={item.text ?? ""} stream={stream} />
            {canExecutePlan && item.event && (
              <button
                type="button"
                className="executePlanButton"
                onClick={() => void onExecutePlan(item.event!)}
              >
                <Play size={16} />
                执行该计划
              </button>
            )}
          </div>
        )}

        {item.kind === "reasoning" && (
          <div className="reasoningBlock">
            <MarkdownText text={item.text ?? ""} />
          </div>
        )}

        {item.kind === "codeChange" && item.codeChange && (
          <CodeChangeCard
            change={item.codeChange}
            rollbackDisabled={rollbackDisabled}
            onRollbackSnapshot={onRollbackSnapshot}
          />
        )}

        {item.kind === "codeChangeSummary" && item.codeChangeGroup && (
          <CodeChangeSummaryCard
            group={item.codeChangeGroup}
            rollbackDisabled={rollbackDisabled}
            onRollbackSnapshot={onRollbackSnapshot}
            onRollbackSnapshots={onRollbackSnapshots}
          />
        )}

        {(item.kind === "statusSummary" || item.kind === "hiddenDetail") && (
          <p className="statusText">{item.text}</p>
        )}

        {item.hiddenSummary && (
          <div className="hiddenSummary">
            <Wrench size={13} />
            <span>{item.hiddenSummary}</span>
          </div>
        )}
        <HiddenDetails events={hiddenDetails} />
      </div>
    </article>
  );
}

function CodeChangeCard({
  change,
  rollbackDisabled,
  onRollbackSnapshot,
  onRollbackSnapshots
}: {
  change: TimelineCodeChange;
  rollbackDisabled: boolean;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRollbackSnapshots?: (snapshotIds: string[], successText?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rollbackSnapshotIds = change.snapshotIds ?? (change.snapshotId ? [change.snapshotId] : []);
  const rollbackDisabledState = rollbackDisabled || rollbackSnapshotIds.length === 0;
  return (
    <div className="codeChangeCard">
      <button
        type="button"
        className="codeChangeHeader"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <FileCode2 size={16} />
        <span>{change.path}</span>
        <small>{change.operation}</small>
        <b className="patchStat add">+{change.stats.added}</b>
        <b className="patchStat del">-{change.stats.deleted}</b>
      </button>
      {expanded && <pre>{change.patch}</pre>}
      <div className="timelineItemActions">
        <button
          type="button"
          className="inlineRollbackButton"
          disabled={rollbackDisabledState}
          onClick={() => {
            if (!rollbackSnapshotIds.length) {
              return;
            }
            if (onRollbackSnapshots && rollbackSnapshotIds.length > 1) {
              onRollbackSnapshots(rollbackSnapshotIds, "已回滚该文件修改");
              return;
            }
            onRollbackSnapshot(rollbackSnapshotIds[0]);
          }}
          title={rollbackDisabledState ? "缺少快照，不能回滚" : "回滚这次代码修改"}
        >
          <RotateCcw size={15} />
          回滚修改
        </button>
      </div>
    </div>
  );
}

function CodeChangeSummaryCard({
  group,
  rollbackDisabled,
  onRollbackSnapshot,
  onRollbackSnapshots
}: {
  group: TimelineCodeChangeGroup;
  rollbackDisabled: boolean;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRollbackSnapshots: (snapshotIds: string[], successText?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewChanges = group.changes.slice(0, 3);
  const overflowCount = Math.max(0, group.changes.length - previewChanges.length);
  const rollbackDisabledState = rollbackDisabled || group.rollbackSnapshotIds.length === 0;

  return (
    <div className="codeChangeSummaryCard">
      <div className="codeChangeSummaryTop">
        <button
          type="button"
          className="codeChangeSummaryToggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <FileCode2 size={16} />
          <span>修改 {group.stats.files} 个文件</span>
          <b className="patchStat add">+{group.stats.added}</b>
          <b className="patchStat del">-{group.stats.deleted}</b>
        </button>
        <button
          type="button"
          className="inlineRollbackButton"
          disabled={rollbackDisabledState}
          onClick={() => onRollbackSnapshots(group.rollbackSnapshotIds, "已回滚本轮修改")}
          title={rollbackDisabledState ? "没有可回滚的快照" : "回滚本轮代码修改"}
        >
          <RotateCcw size={15} />
          回滚本轮修改
        </button>
      </div>
      <div className="codeChangeSummaryMeta">
        <span>{operationSummary(group.changes)}</span>
        {previewChanges.map((change) => (
          <code key={change.id}>{change.path}</code>
        ))}
        {overflowCount > 0 && <span>另有 {overflowCount} 个文件</span>}
      </div>
      {expanded && (
        <CodeChangeList
          changes={group.changes}
          rollbackDisabled={rollbackDisabled}
          onRollbackSnapshot={onRollbackSnapshot}
          onRollbackSnapshots={onRollbackSnapshots}
        />
      )}
    </div>
  );
}

function CodeChangeList({
  changes,
  rollbackDisabled,
  onRollbackSnapshot,
  onRollbackSnapshots
}: {
  changes: TimelineCodeChange[];
  rollbackDisabled: boolean;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRollbackSnapshots: (snapshotIds: string[], successText?: string) => void;
}) {
  return (
    <div className="codeChangeList">
      {changes.map((change) => (
        <CodeChangeCard
          key={change.id}
          change={change}
          rollbackDisabled={rollbackDisabled}
          onRollbackSnapshot={onRollbackSnapshot}
          onRollbackSnapshots={onRollbackSnapshots}
        />
      ))}
    </div>
  );
}

function HiddenDetails({ events }: { events: EventRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!events.length) {
    return null;
  }
  return (
    <div className="hiddenDetails">
      <button
        type="button"
        className="detailsToggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        查看细节
        <span>{events.length}</span>
      </button>
      {expanded && (
        <div className="detailsList">
          {events.map((event) => (
            <details className="rawEventDetail" key={event.id}>
              <summary>
                <span>{eventLabel(event)}</span>
                <small>#{event.seq}</small>
              </summary>
              <pre>{JSON.stringify(event.data, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

const LONG_MARKDOWN_CHARS = 1200;
const LONG_MARKDOWN_LINES = 18;

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
          {expanded ? "收起" : "展开内容"}
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

type ExecutionSummary = {
  status: Exclude<TimelineStatus, "neutral">;
  statusText: string;
  toolCount: number;
  readCount: number;
  searchCount: number;
  commandCount: number;
  changeCount: number;
  detail: string;
};

type DockDetail = {
  id: string;
  toolName: string;
  label: string;
  target: string;
  status: "success" | "failed" | "pending" | "running";
  errorText?: string;
};

function buildToolAction(
  event: EventRecord,
  resultByToolCall: Map<string, EventRecord>
): DockDetail {
  const name = valueAsString(event.data.name);
  const input = asRecord(event.data.input);
  const label = toolLabel(name);

  let target = "";
  if (name === "shell" || name === "bash") {
    target = valueAsString(input.command);
  } else if (name === "search" || name === "grep") {
    target = valueAsString(input.query) || valueAsString(input.pattern) || valueAsString(input.regex);
  } else {
    target = valueAsString(input.path);
  }
  if (target.length > 80) {
    target = target.slice(0, 77) + "...";
  }

  const result = resultByToolCall.get(event.id);
  let status: DockDetail["status"] = "running";
  let errorText: string | undefined;
  if (result) {
    if (result.type === "tool.success") {
      status = "success";
    } else if (result.type === "tool.failed") {
      status = "failed";
      errorText =
        valueAsString(result.data.error) ||
        valueAsString(asRecord(result.data.result).stderr) ||
        "执行失败";
    } else if (result.type === "tool.pending") {
      status = "pending";
    }
  }

  return { id: event.id, toolName: name, label, target, status, errorText };
}

function buildResultByToolCall(events: EventRecord[]) {
  const resultByToolCall = new Map<string, EventRecord>();
  for (const event of events) {
    const toolCallEventId = valueAsString(event.data.toolCallEventId);
    if (
      toolCallEventId &&
      (event.type === "tool.success" ||
        event.type === "tool.failed" ||
        event.type === "tool.pending")
    ) {
      resultByToolCall.set(toolCallEventId, event);
    }
  }
  return resultByToolCall;
}

function buildDockDetails(events: EventRecord[]): DockDetail[] {
  const resultByToolCall = buildResultByToolCall(events);
  const details: DockDetail[] = [];
  for (const event of events) {
    if (event.type !== "tool.called") {
      continue;
    }
    details.push(buildToolAction(event, resultByToolCall));
  }
  return details;
}

function PlanExecutionDock({
  events,
  snapshots
}: {
  events: EventRecord[];
  snapshots: SnapshotRecord[];
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = buildExecutionSummary(events, snapshots);
  const details = useMemo(() => buildDockDetails(events), [events]);

  return (
    <section className={`planExecutionDock ${expanded ? "expanded" : ""}`}>
      <button
        type="button"
        className="planExecutionHeader"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="planExecutionTitle">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <History size={16} />
          <strong>执行状态</strong>
          <span className={summary.status}>{summary.statusText}</span>
        </div>
        <small>{summary.detail}</small>
      </button>
      <div className="executionSummary">
        <span>
          <Wrench size={14} />
          工具 {summary.toolCount}
        </span>
        <span>读取 {summary.readCount}</span>
        <span>搜索 {summary.searchCount}</span>
        <span>命令 {summary.commandCount}</span>
        <span>修改 {summary.changeCount}</span>
      </div>
      {expanded && (
        <div className="dockDetailList">
          {details.map((detail) => (
            <div key={detail.id} className={`dockDetailItem ${detail.status}`}>
              <span className="dockStatus">
                {detail.status === "success" && <Check size={14} />}
                {detail.status === "failed" && <AlertTriangle size={14} />}
                {detail.status === "pending" && <Clock3 size={14} />}
                {detail.status === "running" && <Loader2 className="spin" size={14} />}
              </span>
              <span className="dockLabel">{detail.label}</span>
              <span className="dockTarget">{detail.target || "—"}</span>
              {detail.errorText && <span className="dockError">{detail.errorText}</span>}
            </div>
          ))}
          {!details.length && <div className="dockDetailItem empty">暂无工具调用记录</div>}
        </div>
      )}
    </section>
  );
}

type StreamDeltaGroup = {
  step: string;
  text: string;
  events: EventRecord[];
};

function collectStreamDeltaGroups(events: EventRecord[], eventType: string) {
  const groups = new Map<string, StreamDeltaGroup>();
  for (const event of events) {
    if (event.type !== eventType) {
      continue;
    }
    const step = streamStepKey(event);
    if (!step) {
      continue;
    }
    const group = groups.get(step) ?? { step, text: "", events: [] };
    group.text += valueAsString(event.data.text);
    group.events.push(event);
    groups.set(step, group);
  }
  return groups;
}

function finalizedStreamSteps(events: EventRecord[], eventType: string) {
  return new Set(
    events
      .filter((event) => event.type === eventType)
      .map(streamStepKey)
      .filter(Boolean)
  );
}

function streamStepKey(event: EventRecord) {
  const step = Number(event.data.step ?? 0);
  return Number.isFinite(step) && step > 0 ? String(step) : "";
}

function buildTimelineItems(
  events: EventRecord[],
  snapshots: SnapshotRecord[]
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const hiddenBuffer: EventRecord[] = [];
  const callById = new Map<string, EventRecord>();
  const eventSeqById = new Map(events.map((event) => [event.id, event.seq]));
  const snapshotsByEventId = new Map<string, SnapshotRecord[]>();
  const consumedSnapshots = new Set<string>();
  const rolledBackSnapshotIds = new Set(
    events
      .filter((event) => event.type === "rollback.applied")
      .map((event) => valueAsString(event.data.snapshotId))
      .filter(Boolean)
  );
  const promptEvents = events.filter((event) => event.type === "prompt.submitted");
  const changeItemsByPromptId = new Map<string, TimelineItem>();
  const assistantDeltaGroups = collectStreamDeltaGroups(events, "assistant.message.delta");
  const reasoningDeltaGroups = collectStreamDeltaGroups(events, "reasoning.summary.delta");
  const assistantFinalSteps = finalizedStreamSteps(events, "assistant.message");
  const reasoningFinalSteps = finalizedStreamSteps(events, "reasoning.summary");
  let currentPromptEvent: EventRecord | null = null;

  for (const event of events) {
    if (event.type === "tool.called") {
      callById.set(event.id, event);
    }
  }
  for (const snapshot of snapshots) {
    if (!snapshot.eventId) {
      continue;
    }
    const bucket = snapshotsByEventId.get(snapshot.eventId) ?? [];
    bucket.push(snapshot);
    snapshotsByEventId.set(snapshot.eventId, bucket);
  }

  function pushItem(item: TimelineItem) {
    if (hiddenBuffer.length) {
      item.details.unshift(...hiddenBuffer.splice(0));
    }
    item.hiddenSummary = summarizeHiddenEvents(item.details, item.event?.id);
    items.push(item);
  }

  function attachHidden(event: EventRecord) {
    const previous = items.at(-1);
    if (!previous) {
      hiddenBuffer.push(event);
      return;
    }
    previous.details.push(event);
    previous.hiddenSummary = summarizeHiddenEvents(previous.details, previous.event?.id);
  }

  function promptForSeq(seq?: number) {
    if (seq === undefined) {
      return currentPromptEvent;
    }
    let promptEvent: EventRecord | null = null;
    for (const event of promptEvents) {
      if (event.seq < seq) {
        promptEvent = event;
      } else {
        break;
      }
    }
    return promptEvent;
  }

  function ensureCodeChangeSummaryItem(event?: EventRecord, promptEvent = currentPromptEvent) {
    const promptKey = promptEvent?.id ?? "unscoped";
    const existing = changeItemsByPromptId.get(promptKey);
    if (existing) {
      return existing;
    }
    const group: TimelineCodeChangeGroup = {
      id: `changes-${promptKey}`,
      promptEventId: promptEvent?.id,
      changes: [],
      stats: { files: 0, added: 0, deleted: 0 },
      rollbackSnapshotIds: []
    };
    const item: TimelineItem = {
      id: group.id,
      kind: "codeChangeSummary",
      title: "代码修改",
      status: "done",
      event,
      details: [],
      codeChangeGroup: group
    };
    pushItem(item);
    changeItemsByPromptId.set(promptKey, item);
    return item;
  }

  function addChangesToSummary(
    item: TimelineItem,
    changes: TimelineCodeChange[],
    detailEvents: EventRecord[]
  ) {
    const group = item.codeChangeGroup;
    if (!group) {
      return;
    }
    const existingChangeIds = new Set(group.changes.map((change) => change.id));
    for (const change of changes) {
      if (!existingChangeIds.has(change.id)) {
        group.changes.push(change);
        existingChangeIds.add(change.id);
      }
    }
    group.changes = mergeCodeChangesByPath(group.changes);
    group.stats = codeChangeGroupStats(group.changes);
    group.rollbackSnapshotIds = group.changes
      .flatMap((change) => change.snapshotIds ?? (change.snapshotId ? [change.snapshotId] : []));

    const existingDetailIds = new Set(item.details.map((detail) => detail.id));
    for (const detail of detailEvents) {
      if (!existingDetailIds.has(detail.id)) {
        item.details.push(detail);
        existingDetailIds.add(detail.id);
      }
    }
    item.hiddenSummary = summarizeHiddenEvents(item.details, item.event?.id);
  }

  for (const event of events) {
    if (event.type === "prompt.submitted") {
      currentPromptEvent = event;
      pushItem({
        id: event.id,
        kind: "userPrompt",
        title: "用户提示词",
        text: valueAsString(event.data.prompt),
        attachments: promptAttachmentSummaries(event.data.attachments),
        status: "done",
        event,
        details: [event],
        rollbackSnapshotIds: promptRollbackSnapshotIds(
          event,
          events,
          snapshots,
          eventSeqById,
          rolledBackSnapshotIds
        )
      });
      continue;
    }

    if (event.type === "assistant.message.delta") {
      const step = streamStepKey(event);
      const group = assistantDeltaGroups.get(step);
      if (group && !assistantFinalSteps.has(step) && group.events[0]?.id === event.id) {
        pushItem({
          id: `assistant-stream-${step}`,
          kind: "assistantReply",
          title: "助手回复",
          text: stripReasoningControlTags(group.text),
          status: "running",
          event,
          details: group.events
        });
      }
      continue;
    }

    if (event.type === "reasoning.summary.delta") {
      const step = streamStepKey(event);
      const group = reasoningDeltaGroups.get(step);
      if (group && !reasoningFinalSteps.has(step) && group.events[0]?.id === event.id) {
        pushItem({
          id: `reasoning-stream-${step}`,
          kind: "reasoning",
          title: "思考过程",
          text: group.text,
          status: "running",
          event,
          details: group.events
        });
      }
      continue;
    }

    if (event.type === "assistant.message") {
      const deltaGroup = assistantDeltaGroups.get(streamStepKey(event));
      pushItem({
        id: event.id,
        kind: "assistantReply",
        title: "助手回复",
        text: stripReasoningControlTags(valueAsString(event.data.text)),
        status: "done",
        event,
        details: deltaGroup ? [event, ...deltaGroup.events] : [event]
      });
      continue;
    }

    if (event.type === "reasoning.summary") {
      const deltaGroup = reasoningDeltaGroups.get(streamStepKey(event));
      pushItem({
        id: event.id,
        kind: "reasoning",
        title: "思考过程",
        text: valueAsString(event.data.text),
        status: "done",
        event,
        details: deltaGroup ? [event, ...deltaGroup.events] : [event]
      });
      continue;
    }

    if (event.type === "tool.success") {
      const changes = codeChangesForToolResult(
        event,
        snapshotsByEventId,
        eventSeqById,
        consumedSnapshots,
        rolledBackSnapshotIds
      );
      if (changes.length) {
        const call = callById.get(valueAsString(event.data.toolCallEventId));
        const promptEvent = promptForSeq(event.seq);
        const item = ensureCodeChangeSummaryItem(event, promptEvent);
        addChangesToSummary(item, changes, call ? [call, event] : [event]);
        continue;
      }
    }

    const statusItem = statusItemForEvent(event);
    if (statusItem) {
      pushItem(statusItem);
      continue;
    }

    attachHidden(event);
  }

  for (const snapshot of snapshots) {
    if (consumedSnapshots.has(snapshot.id)) {
      continue;
    }
    if (rolledBackSnapshotIds.has(snapshot.id)) {
      continue;
    }
    const seq = snapshot.eventId ? eventSeqById.get(snapshot.eventId) : undefined;
    const item = ensureCodeChangeSummaryItem(undefined, promptForSeq(seq));
    addChangesToSummary(item, [codeChangeFromSnapshot(snapshot, seq)], []);
  }

  if (hiddenBuffer.length) {
    pushItem({
      id: `hidden-${hiddenBuffer[0].id}`,
      kind: "hiddenDetail",
      title: "运行细节",
      text: summarizeHiddenEvents(hiddenBuffer) || "低优先级事件",
      status: "neutral",
      details: hiddenBuffer.splice(0)
    });
  }

  return items;
}

function codeChangesForToolResult(
  event: EventRecord,
  snapshotsByEventId: Map<string, SnapshotRecord[]>,
  eventSeqById: Map<string, number>,
  consumedSnapshots: Set<string>,
  rolledBackSnapshotIds: Set<string>
) {
  const toolCallEventId = valueAsString(event.data.toolCallEventId);
  const snapshotChanges = [
    ...(snapshotsByEventId.get(event.id) ?? []),
    ...(toolCallEventId ? (snapshotsByEventId.get(toolCallEventId) ?? []) : [])
  ];
  if (snapshotChanges.length) {
    return snapshotChanges
      .filter((snapshot) => !rolledBackSnapshotIds.has(snapshot.id))
      .map((snapshot) => {
        consumedSnapshots.add(snapshot.id);
        return codeChangeFromSnapshot(snapshot, snapshot.eventId ? eventSeqById.get(snapshot.eventId) : event.seq);
      });
  }

  const result = asRecord(event.data.result);
  const patch = valueAsString(result.patch);
  if (!patch) {
    return [];
  }
  const path = valueAsString(result.path) || "未知文件";
  return [
    {
      id: `patch-${event.id}`,
      path,
      operation: operationLabel(valueAsString(event.data.name), null),
      patch,
      stats: patchLineStats(patch),
      order: event.seq,
      createdAt: event.createdAt
    }
  ];
}

function codeChangeFromSnapshot(snapshot: SnapshotRecord, order = 0): TimelineCodeChange {
  return {
    id: `snapshot-${snapshot.id}`,
    snapshotId: snapshot.id,
    snapshotIds: [snapshot.id],
    path: snapshot.path,
    operation: operationLabel("", snapshot),
    patch: snapshot.patch,
    stats: patchLineStats(snapshot.patch),
    beforeContent: snapshot.beforeContent ?? null,
    afterContent: snapshot.afterContent ?? null,
    order,
    createdAt: snapshot.createdAt
  };
}

function codeChangeGroupStats(changes: TimelineCodeChange[]) {
  return changes.reduce(
    (stats, change) => ({
      files: stats.files + 1,
      added: stats.added + change.stats.added,
      deleted: stats.deleted + change.stats.deleted
    }),
    { files: 0, added: 0, deleted: 0 }
  );
}

function mergeCodeChangesByPath(changes: TimelineCodeChange[]) {
  const byPath = new Map<string, TimelineCodeChange[]>();
  for (const change of changes) {
    const bucket = byPath.get(change.path) ?? [];
    bucket.push(change);
    byPath.set(change.path, bucket);
  }

  return Array.from(byPath.values()).map((bucket) => mergeFileCodeChanges(bucket));
}

function mergeFileCodeChanges(changes: TimelineCodeChange[]): TimelineCodeChange {
  const snapshotBackedChanges = changes.filter(
    (change) => change.snapshotId || change.snapshotIds?.length
  );
  const sourceChanges = snapshotBackedChanges.length ? snapshotBackedChanges : changes;
  const sorted = [...sourceChanges].sort(compareCodeChangeOrder);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (sorted.length === 1) {
    return {
      ...first,
      snapshotIds: first.snapshotIds ?? (first.snapshotId ? [first.snapshotId] : [])
    };
  }

  const snapshotIds = sorted
    .flatMap((change) => change.snapshotIds ?? (change.snapshotId ? [change.snapshotId] : []))
    .filter(Boolean)
    .reverse();
  const canBuildNetPatch =
    first.beforeContent !== undefined && last.afterContent !== undefined;
  const patch = canBuildNetPatch
    ? createUnifiedDiffPreview(
        first.path,
        first.beforeContent ?? "",
        last.afterContent ?? ""
      )
    : sorted.map((change) => change.patch).join("\n");
  const operation =
    first.beforeContent === null
      ? "新增"
      : last.afterContent === null
        ? "删除"
        : `修改 ${sorted.length} 次`;

  return {
    ...last,
    id: `path-${first.path}`,
    snapshotId: snapshotIds[0],
    snapshotIds,
    operation,
    patch,
    stats: patchLineStats(patch),
    beforeContent: first.beforeContent,
    afterContent: last.afterContent,
    order: first.order,
    createdAt: last.createdAt
  };
}

function compareCodeChangeOrder(left: TimelineCodeChange, right: TimelineCodeChange) {
  const leftOrder = left.order ?? 0;
  const rightOrder = right.order ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
}

function promptRollbackSnapshotIds(
  promptEvent: EventRecord,
  events: EventRecord[],
  snapshots: SnapshotRecord[],
  eventSeqById: Map<string, number>,
  rolledBackSnapshotIds: Set<string>
) {
  const nextPromptSeq =
    events.find(
      (event) => event.type === "prompt.submitted" && event.seq > promptEvent.seq
    )?.seq ?? Number.POSITIVE_INFINITY;
  return snapshots
    .filter((snapshot) => {
      if (!snapshot.eventId) {
        return false;
      }
      const seq = eventSeqById.get(snapshot.eventId);
      return seq !== undefined && seq > promptEvent.seq && seq < nextPromptSeq;
    })
    .sort((left, right) => {
      const leftSeq = left.eventId ? (eventSeqById.get(left.eventId) ?? 0) : 0;
      const rightSeq = right.eventId ? (eventSeqById.get(right.eventId) ?? 0) : 0;
      if (rightSeq !== leftSeq) {
        return rightSeq - leftSeq;
      }
      return right.createdAt.localeCompare(left.createdAt);
    })
    .filter((snapshot) => !rolledBackSnapshotIds.has(snapshot.id))
    .map((snapshot) => snapshot.id);
}

function operationLabel(toolName: string, snapshot: SnapshotRecord | null) {
  if (snapshot?.afterContent === null) {
    return "删除";
  }
  if (snapshot?.beforeContent === null) {
    return "新增";
  }
  const labels: Record<string, string> = {
    edit: "编辑",
    write: "写入",
    delete: "删除"
  };
  return labels[toolName] ?? "修改";
}

function operationSummary(changes: TimelineCodeChange[]) {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.operation, (counts.get(change.operation) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([operation, count]) => (count > 1 ? `${operation} ${count}` : operation))
    .join(" · ");
}

function statusItemForEvent(event: EventRecord): TimelineItem | null {
  if (event.type === "tool.pending") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: "等待确认",
      text: pendingCommand(event),
      status: "waiting",
      event,
      details: [event]
    };
  }
  if (event.type === "tool.failed") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: "工具失败",
      text: eventFailureText(event),
      status: "failed",
      event,
      details: [event]
    };
  }
  if (event.type === "tool.rejected") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: "已拒绝工具",
      text: toolLabel(valueAsString(event.data.name)),
      status: "failed",
      event,
      details: [event]
    };
  }
  if (event.type === "policy.blocked") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: "策略拦截",
      text: valueAsString(event.data.reason) || "请求被策略拦截",
      status: "failed",
      event,
      details: [event]
    };
  }
  if (event.type === "step.failed") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: "执行失败",
      text: valueAsString(event.data.error),
      status: "failed",
      event,
      details: [event]
    };
  }
  if (event.type === "agent.cancelRequested" || event.type === "agent.stopped") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: event.type === "agent.stopped" ? "已停止" : "请求停止",
      text: valueAsString(event.data.reason) || eventLabel(event),
      status: event.type === "agent.stopped" ? "done" : "waiting",
      event,
      details: [event]
    };
  }
  if (event.type === "rollback.applied") {
    return null;
  }
  return null;
}

function eventFailureText(event: EventRecord) {
  const result = asRecord(event.data.result);
  return (
    valueAsString(event.data.error) ||
    valueAsString(result.stderr) ||
    valueAsString(result.stdout) ||
    "工具执行失败"
  );
}

function summarizeHiddenEvents(events: EventRecord[], primaryEventId = "") {
  const hidden = events.filter((event) => event.id !== primaryEventId);
  if (!hidden.length) {
    return "";
  }
  const toolCalls = hidden.filter((event) => event.type === "tool.called");
  const reads = toolCalls.filter((event) => valueAsString(event.data.name) === "read").length;
  const searches = toolCalls.filter((event) => {
    const name = valueAsString(event.data.name);
    return name === "search" || name === "grep";
  }).length;
  const commands = toolCalls.filter((event) => {
    const name = valueAsString(event.data.name);
    return name === "shell" || name === "bash";
  }).length;
  const steps = hidden.filter((event) => event.type.startsWith("step.")).length;
  const parts = [
    toolCalls.length ? `${toolCalls.length} 个工具调用` : "",
    reads ? `${reads} 次读取` : "",
    searches ? `${searches} 次搜索` : "",
    commands ? `${commands} 条命令` : "",
    steps ? `${steps} 个步骤事件` : ""
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${hidden.length} 条细节`;
}

function buildExecutionSummary(
  events: EventRecord[],
  snapshots: SnapshotRecord[]
): ExecutionSummary {
  const resultByToolCall = new Map<string, EventRecord>();
  const resolvedPending = new Set(
    events
      .map((event) => valueAsString(event.data.pendingEventId))
      .filter(Boolean)
  );

  for (const event of events) {
    const toolCallEventId = valueAsString(event.data.toolCallEventId);
    if (
      toolCallEventId &&
      (event.type === "tool.success" ||
        event.type === "tool.failed" ||
        event.type === "tool.pending")
    ) {
      resultByToolCall.set(toolCallEventId, event);
    }
  }

  const toolCalls = events.filter((event) => event.type === "tool.called");
  const readCount = toolCalls.filter((event) => valueAsString(event.data.name) === "read").length;
  const searchCount = toolCalls.filter((event) => {
    const name = valueAsString(event.data.name);
    return name === "search" || name === "grep";
  }).length;
  const commandCount = toolCalls.filter((event) => {
    const name = valueAsString(event.data.name);
    return name === "shell" || name === "bash";
  }).length;
  const failed = events.some(
    (event) => event.type.includes("failed") || event.type === "policy.blocked"
  );
  const waiting = events.some(
    (event) => event.type === "tool.pending" && !resolvedPending.has(event.id)
  );
  const runningTool = toolCalls.some((event) => !resultByToolCall.has(event.id));
  const runningStep = events.some((event) => {
    if (event.type !== "step.started") {
      return false;
    }
    const step = Number(event.data.step ?? 0);
    return !events.some(
      (item) =>
        (item.type === "step.ended" || item.type === "step.failed") &&
        Number(item.data.step ?? 0) === step
    );
  });
  const eventIds = new Set(events.map((event) => event.id));
  const snapshotChangePaths = new Set(
    snapshots
      .filter((snapshot) => snapshot.eventId && eventIds.has(snapshot.eventId))
      .map((snapshot) => snapshot.path)
  );
  const fallbackPatchPaths = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool.success") {
      continue;
    }
    const result = asRecord(event.data.result);
    const path = valueAsString(result.path);
    const toolCallEventId = valueAsString(event.data.toolCallEventId);
    const hasSnapshot = snapshots.some(
      (snapshot) =>
        snapshot.eventId === event.id || (toolCallEventId && snapshot.eventId === toolCallEventId)
    );
    if (!hasSnapshot && path && valueAsString(result.patch)) {
      fallbackPatchPaths.add(path);
    }
  }
  const changeCount = new Set([...snapshotChangePaths, ...fallbackPatchPaths]).size;
  const status: ExecutionSummary["status"] = failed
    ? "failed"
    : waiting
      ? "waiting"
      : runningTool || runningStep
        ? "running"
        : "done";
  const statusText =
    status === "failed"
      ? "执行异常"
      : status === "waiting"
        ? "等待确认"
        : status === "running"
          ? "执行中"
          : "已完成";

  return {
    status,
    statusText,
    toolCount: toolCalls.length,
    readCount,
    searchCount,
    commandCount,
    changeCount,
    detail: `${events.length} 条事件 · ${changeCount} 个文件变更`
  };
}

function timelineItemIcon(item: TimelineItem) {
  if (item.kind === "userPrompt") {
    return <Pencil size={16} />;
  }
  if (item.kind === "assistantReply") {
    return <Bot size={16} />;
  }
  if (item.kind === "reasoning") {
    return <BrainCircuit size={16} />;
  }
  if (item.kind === "codeChange" || item.kind === "codeChangeSummary") {
    return <FileCode2 size={16} />;
  }
  if (item.status === "failed") {
    return <AlertTriangle size={16} />;
  }
  if (item.status === "waiting") {
    return <Clock3 size={16} />;
  }
  if (item.status === "running") {
    return <Loader2 className="spin" size={16} />;
  }
  return <Check size={16} />;
}

const DIFF_CONTEXT_LINES = 3;

function createUnifiedDiffPreview(filePath: string, oldContent: string, newContent: string) {
  const oldLines = splitPatchLines(oldContent);
  const newLines = splitPatchLines(newContent);
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - 1 - suffixLength] ===
      newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const oldChangeEnd = oldLines.length - suffixLength;
  const newChangeEnd = newLines.length - suffixLength;
  const oldStart = Math.max(0, prefixLength - DIFF_CONTEXT_LINES);
  const newStart = Math.max(0, prefixLength - DIFF_CONTEXT_LINES);
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + DIFF_CONTEXT_LINES);
  const newEnd = Math.min(newLines.length, newChangeEnd + DIFF_CONTEXT_LINES);
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`
  ];

  for (const line of oldLines.slice(oldStart, prefixLength)) {
    lines.push(` ${line}`);
  }
  for (const line of oldLines.slice(prefixLength, oldChangeEnd)) {
    lines.push(`-${line}`);
  }
  for (const line of newLines.slice(prefixLength, newChangeEnd)) {
    lines.push(`+${line}`);
  }
  const sharedSuffixStart = oldLines.length - suffixLength;
  for (const line of oldLines.slice(sharedSuffixStart, oldEnd)) {
    lines.push(` ${line}`);
  }

  return `${lines.join("\n")}\n`;
}

function splitPatchLines(content: string) {
  if (!content) {
    return [""];
  }
  return content.replace(/\r\n/g, "\n").split("\n");
}

function patchLineStats(patch: string) {
  let added = 0;
  let deleted = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      deleted += 1;
    }
  }
  return { added, deleted };
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
  onChange,
  className = "",
  disabled = false
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`segmented ${className}`.trim()}>
      {options.map(([optionValue, label]) => (
        <button
          type="button"
          key={optionValue}
          className={value === optionValue ? "active" : ""}
          disabled={disabled}
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

function eventLabel(event: EventRecord) {
  const labels: Record<string, string> = {
    "prompt.submitted": "用户提示词",
    "step.started": "步骤开始",
    "step.ended": "步骤结束",
    "step.failed": "步骤失败",
    "llm.stream.started": "模型流开始",
    "llm.stream.finished": "模型流结束",
    "reasoning.summary": "过程摘要",
    "reasoning.summary.delta": "过程摘要片段",
    "assistant.message": "助手回复",
    "assistant.message.delta": "助手回复片段",
    "tool.input.delta": "工具参数片段",
    "tool.called": "工具调用",
    "tool.success": "工具成功",
    "tool.failed": "工具失败",
    "tool.pending": "等待确认",
    "tool.approved": "已批准工具",
    "tool.rejected": "已拒绝工具",
    "plan.candidateTool": "候选工具",
    "policy.blocked": "策略拦截",
    "agent.cancelRequested": "请求停止",
    "agent.stopped": "Agent 已停止",
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

function visiblePermissionRequests(requests: PermissionRequestRecord[]) {
  return requests.filter(
    (request) => request.status === "pending" && !isToolPermissionRequest(request)
  );
}

function isToolPermissionRequest(request: PermissionRequestRecord) {
  const source = asRecord(request.sourceJson);
  return source.type === "tool";
}

function shellAllowlistPrefix(command: string) {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  const first = normalized.split(" ")[0] ?? normalized;
  if (first === "cd") {
    return "cd";
  }
  if (first === "npm" || first === "pnpm" || first === "yarn") {
    const parts = normalized.split(" ");
    if (parts[1] === "run" && parts[2]) {
      return `${parts[0]} run ${parts[2]}`;
    }
    return parts.slice(0, 2).join(" ");
  }
  if (first === "cargo" || first === "git") {
    const parts = normalized.split(" ");
    return parts.slice(0, 2).join(" ");
  }
  return first;
}

function hasUnresolvedPendingTools(events: EventRecord[]) {
  const resolved = new Set(
    events
      .map((event) => valueAsString(event.data.pendingEventId))
      .filter(Boolean)
  );
  return events.some(
    (event) => event.type === "tool.pending" && !resolved.has(event.id)
  );
}

function valueAsString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stripReasoningControlTags(value: string) {
  let output = "";
  let index = 0;
  let inReasoning = false;
  while (index < value.length) {
    const tagStart = value.indexOf("<", index);
    if (tagStart === -1) {
      if (!inReasoning) {
        output += value.slice(index);
      }
      break;
    }
    if (!inReasoning) {
      output += value.slice(index, tagStart);
    }
    const match = value.slice(tagStart).match(/^<\/?think(?:_[A-Za-z0-9_-]+)?(?:\s[^>]*)?>/);
    if (!match) {
      if (!inReasoning) {
        output += "<";
      }
      index = tagStart + 1;
      continue;
    }
    inReasoning = !match[0].startsWith("</");
    index = tagStart + match[0].length;
  }
  return output;
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

const PLAN_EXECUTION_PROMPT_PREFIX = "请执行下面这份计划。";

function buildPlanExecutionPrompt(planText: string) {
  return `${PLAN_EXECUTION_PROMPT_PREFIX}

执行要求：
- 按计划逐步修改代码，不要跳过必要的读取、搜索和验证。
- 每完成一个重要阶段，在 message 中用一句话说明当前进度。
- 工具调用 JSON 必须严格遵守协议：toolCalls 的每个元素只能包含 name 和 input，不要在 toolCalls 元素里添加 done 字段。
- 如果工具失败，请根据错误信息自我修正后继续。

计划内容：
${planText}`;
}

function latestPlanExecutionEvents(events: EventRecord[]) {
  let startIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "prompt.submitted") {
      if (valueAsString(event.data.prompt).trimStart().startsWith(PLAN_EXECUTION_PROMPT_PREFIX)) {
        startIndex = index;
      }
      break;
    }
  }
  if (startIndex < 0) {
    return [];
  }
  return events.slice(startIndex);
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

type ContextUsageSeverity = "ok" | "warning" | "danger";
type ContextUsageSource = "provider" | "estimate";

type ContextUsageTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
  total: number;
};

type ContextUsage = {
  percent: number;
  barPercent: number;
  usedTokens: number;
  maxTokens: number;
  source: ContextUsageSource;
  severity: ContextUsageSeverity;
  tokens: ContextUsageTokens;
  providerId?: string;
  model?: string;
  step?: number;
  limitIsDefault: boolean;
  notes: string[];
};

function contextUsageFromEvents(eventsResponse: SessionEventsResponse): ContextUsage | null {
  const event = [...eventsResponse.events]
    .reverse()
    .find((item) => item.type === "context.usage");
  if (!event) {
    return null;
  }

  const data = asRecord(event.data);
  const tokens = asRecord(data.tokens);
  const cache = asRecord(tokens.cache);
  const contextLimit = valueAsNumber(data.contextLimit);
  const maxTokens = contextLimit ?? 128_000;
  const usedTokens = valueAsNumber(data.usedForContext) ?? valueAsNumber(tokens.total) ?? 0;
  const percent =
    valueAsNumber(data.percent) ?? Math.ceil((usedTokens / Math.max(1, maxTokens)) * 100);
  const normalizedTokens: ContextUsageTokens = {
    input: valueAsNumber(tokens.input) ?? 0,
    output: valueAsNumber(tokens.output) ?? 0,
    reasoning: valueAsNumber(tokens.reasoning) ?? 0,
    cache: {
      read: valueAsNumber(cache.read) ?? 0,
      write: valueAsNumber(cache.write) ?? 0
    },
    total: valueAsNumber(tokens.total) ?? usedTokens
  };
  const limitIsDefault = !contextLimit;
  const notes = [
    "来源: Provider 实际 usage。",
    limitIsDefault ? "上下文上限来自默认 128,000 tokens。" : ""
  ].filter((note) => note.length > 0);

  return {
    percent,
    barPercent: Math.min(100, Math.max(0, percent)),
    usedTokens,
    maxTokens,
    source: "provider",
    severity: contextUsageSeverity(percent),
    tokens: normalizedTokens,
    providerId: valueAsString(data.providerId),
    model: valueAsString(data.model),
    step: valueAsNumber(data.step) ?? undefined,
    limitIsDefault,
    notes
  };
}

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
}): ContextUsage {
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
  const percent = Math.ceil((usedTokens / maxTokens) * 100);
  const limitIsDefault = !limit;

  return {
    percent,
    barPercent: Math.min(100, Math.max(0, percent)),
    usedTokens,
    maxTokens,
    source: "estimate",
    severity: contextUsageSeverity(percent),
    tokens: {
      input: usedTokens,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0
      },
      total: usedTokens
    },
    providerId: splitProviderRecordId(selectedProviderId).providerId,
    model: splitProviderRecordId(selectedProviderId).modelId,
    limitIsDefault,
    notes: [
      `来源: 本地估算，最近事件 ${Math.min(eventsResponse.events.length, 36)} / ${eventsResponse.events.length}。`,
      limitIsDefault ? "上下文上限来自默认 128,000 tokens。" : "",
      "说明: 按当前发送给模型的压缩上下文估算，非供应商实际 usage。"
    ].filter((note) => note.length > 0)
  };
}

function contextUsageSeverity(percent: number): ContextUsageSeverity {
  if (percent >= 95) {
    return "danger";
  }
  if (percent >= 80) {
    return "warning";
  }
  return "ok";
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
    const providerKeys = Object.keys(providers ?? {});
    const providerId =
      selected.providerId && providers?.[selected.providerId]
        ? selected.providerId
        : (providerKeys[0] ?? "");
    const provider = providerRecord(config, providerId);
    const models = provider.models as Record<string, unknown> | undefined;
    const modelKeys = Object.keys(models ?? {});
    const modelId =
      selected.modelId &&
      (models?.[selected.modelId] || !modelKeys.length)
        ? selected.modelId
        : (modelKeys[0] ?? "");
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
    if (choices.length) {
      return choices;
    }
    const fallbackProvider = splitProviderRecordId(fallback).providerId || fallback;
    return fallbackProvider ? [fallbackProvider] : providers.map((item) => item.id.split("/")[0]);
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
    if (choices.length) {
      return choices;
    }
    return fallback || providerId ? [fallback || "default"] : ["default"];
  } catch {
    return fallback ? [fallback] : ["default"];
  }
}

function providerModelLabel(provider: ProviderRecord) {
  const displayName = stripProviderNamePrefix(provider.name);
  if (displayName && displayName !== provider.name.trim()) {
    return displayName;
  }
  return (
    provider.model ||
    splitProviderRecordId(provider.id).modelId ||
    provider.name ||
    provider.id
  );
}

function stripProviderNamePrefix(value: string) {
  const trimmed = value.trim();
  const separator = " / ";
  if (!trimmed.includes(separator)) {
    return trimmed;
  }
  return trimmed.split(separator).slice(1).join(separator).trim() || trimmed;
}

function attachmentKindsFromConfig(
  content: string,
  selectedProviderId: string
): PromptAttachmentKind[] {
  try {
    const config = JSON.parse(content) as Record<string, unknown>;
    const selected = splitProviderRecordId(
      selectedProviderId || valueAsString(config.model)
    );
    const provider = providerRecord(config, selected.providerId);
    const model = asRecord(asRecord(provider.models)[selected.modelId]);
    const modalities = asRecord(model.modalities);
    const input = Array.isArray(modalities.input) ? modalities.input : ["text"];
    const kinds = input
      .map((item) => valueAsString(item).toLowerCase())
      .filter((item): item is PromptAttachmentKind => item === "text" || item === "image");
    return Array.from(new Set(kinds));
  } catch {
    return ["text"];
  }
}

function attachmentAcceptValue(kinds: PromptAttachmentKind[]) {
  const values: string[] = [];
  if (kinds.includes("image")) {
    values.push("image/*");
  }
  if (kinds.includes("text")) {
    values.push(
      "text/*",
      "application/json",
      "application/xml",
      ".txt",
      ".md",
      ".markdown",
      ".json",
      ".jsonl",
      ".csv",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".rs",
      ".go",
      ".java",
      ".kt",
      ".swift",
      ".c",
      ".cpp",
      ".h",
      ".hpp",
      ".cs",
      ".html",
      ".css",
      ".scss",
      ".xml",
      ".yaml",
      ".yml",
      ".toml",
      ".sql",
      ".sh",
      ".ps1",
      ".bat",
      ".log"
    );
  }
  return values.join(",");
}

function attachmentUploadTitle(kinds: PromptAttachmentKind[]) {
  if (!kinds.length) {
    return "当前模型配置不支持附件上传";
  }
  const labels = kinds.map((kind) => (kind === "image" ? "图片" : "文本文件"));
  return `上传附件，可选类型：${labels.join("、")}`;
}

async function readPromptAttachment(
  file: File,
  allowedKinds: PromptAttachmentKind[]
): Promise<PromptAttachment> {
  const kind = promptAttachmentKindForFile(file, allowedKinds);
  if (!kind) {
    throw new Error(`当前模型不支持该附件类型：${file.name}`);
  }
  if (kind === "text" && file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(`文本附件过大：${file.name}，最大 ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}。`);
  }
  if (kind === "image" && file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`图片附件过大：${file.name}，最大 ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}。`);
  }

  return {
    id: newId(),
    name: file.name,
    mime: attachmentMimeForFile(file, kind),
    size: file.size,
    kind,
    content: kind === "image" ? await readFileAsDataUrl(file, attachmentMimeForFile(file, kind)) : await readFileAsText(file)
  };
}

function promptAttachmentKindForFile(
  file: File,
  allowedKinds: PromptAttachmentKind[]
): PromptAttachmentKind | null {
  if (allowedKinds.includes("image") && fileLooksImage(file)) {
    return "image";
  }
  if (allowedKinds.includes("text") && fileLooksText(file)) {
    return "text";
  }
  return null;
}

function fileLooksImage(file: File) {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name)
  );
}

function attachmentMimeForFile(file: File, kind: PromptAttachmentKind) {
  if (file.type) {
    return file.type;
  }
  if (kind === "image") {
    const ext = file.name.toLowerCase().split(".").pop();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "bmp") return "image/bmp";
    if (ext === "avif") return "image/avif";
    return "image/png";
  }
  return "text/plain";
}

function fileLooksText(file: File) {
  if (file.type.startsWith("text/")) {
    return true;
  }
  const mime = file.type.toLowerCase();
  if (
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/typescript",
      "application/x-sh",
      "application/x-yaml"
    ].includes(mime)
  ) {
    return true;
  }
  return /\.(txt|md|markdown|json|jsonl|csv|ts|tsx|js|jsx|py|rs|go|java|kt|swift|c|cpp|h|hpp|cs|html|css|scss|xml|ya?ml|toml|sql|sh|ps1|bat|log)$/i.test(
    file.name
  );
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取附件：${file.name}`));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.replace(/^data:[^;,]*/, `data:${mime}`));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取附件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function toPromptAttachmentInput(attachment: PromptAttachment): PromptAttachmentInput {
  return {
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    kind: attachment.kind,
    content: attachment.content
  };
}

function promptAttachmentSummaries(value: unknown): PromptAttachmentSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const name = valueAsString(record.name);
    const kind = valueAsString(record.kind);
    if (!name || (kind !== "text" && kind !== "image")) {
      return [];
    }
    return [
      {
        name,
        kind,
        mime: valueAsString(record.mime) || (kind === "image" ? "image/*" : "text/plain"),
        size: valueAsNumber(record.size) ?? 0
      }
    ];
  });
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
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
