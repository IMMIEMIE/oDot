import {
  AlertTriangle,
  ArrowUp,
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
  MessageSquare,
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
import { OdodBotIcon } from "./OdodBotIcon";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  PointerEvent,
  ReactNode
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  approveToolCall,
  cancelJob,
  cancelSession,
  compactSession,
  continueSession,
  createSession,
  deleteSession,
  fetchProjectFiles,
  findOpencodeConfig,
  getSessionEvents,
  tailSessionEvents,
  listSessions,
  loadShellPolicy,
  loadProviderConfig,
  pickProjectDirectory,
  rejectToolCall,
  replyPermission,
  recoverSessionFromCheckpoint,
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
import {
  deriveFloatAgentStatus,
  saveFloatAgentStatus
} from "./floatAgentStatus";
import {
  clipboardFiles,
  readPromptAttachment,
  shellAllowlistPrefix,
  toPromptAttachmentInput,
  type PromptAttachment,
  type PromptAttachmentKind
} from "./promptAttachments";
import {
  appT,
  buildPlanExecutionPrompt,
  type AppLocale,
  PLAN_EXECUTION_MARKER,
  recoveryActionDescription,
  recoveryActionLabel,
  setAppLocale
} from "./i18n";
import i18n from "./i18n";

type Notice = {
  tone: "info" | "success" | "error";
  text: string;
};

type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

type PromptAttachmentSummary = Omit<PromptAttachment, "id" | "content">;

type TreeNode = {
  type: "dir" | "file";
  name: string;
  path: string;
  file?: ProjectFile;
  children: TreeNode[];
};

export function App() {
  const { t } = useTranslation();
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
  const [, setNotice] = useState<Notice>({
    tone: "info",
    text: i18n.t("notice.ready")
  });
  const [, setIsBooting] = useState(true);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [isSetupSaving, setIsSetupSaving] = useState(false);
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("odot.themeMode");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToTimelineBottomRef = useRef(true);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const shellModeMenuRef = useRef<HTMLDivElement | null>(null);
  const realtimeTailTimerRef = useRef<number | undefined>(undefined);
  const activeRunIdRef = useRef(0);
  const stopBaselineSeqRef = useRef(0);
  const rollbackInFlightRef = useRef(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isShellModeMenuOpen, setIsShellModeMenuOpen] = useState(false);
  const [promptAttachments, setPromptAttachments] = useState<PromptAttachment[]>([]);
  const [leftWidth, setLeftWidth] = useState(() => {
    const stored = Number(localStorage.getItem("odot.leftWidth"));
    return Number.isFinite(stored) && stored >= 300 ? stored : 420;
  });
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(true);

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
      const resolvedTheme: ResolvedTheme =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
      void emit("odot:theme-change", { theme: resolvedTheme });
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
      setLeftWidth((current) => {
        const maxLeftWidth = Math.max(260, Math.min(620, window.innerWidth - 360));
        return Math.min(current, maxLeftWidth);
      });
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
        setNotice({ tone: "success", text: i18n.t("notice.agentStopped") });
      }
      if (
        payload.kind === "session.start" ||
        payload.kind === "task.created" ||
        payload.kind === "task.completed" ||
        payload.kind === "task.failed"
      ) {
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

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ sessionId: string }>("odot:float-session-refresh", ({ payload }) => {
      if (disposed || payload.sessionId !== selectedSessionId) {
        return;
      }
      scheduleRealtimeTailRefresh(payload.sessionId);
      void refreshSessions().catch(() => undefined);
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
  }, [selectedSessionId]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId]
  );
  const selectedModelLabel = selectedProvider
    ? providerModelLabel(selectedProvider)
    : t("session.noModelSelected");
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
  const orderedSessions = useMemo(
    () => orderSessionsByParent(availableSessions),
    [availableSessions]
  );
  const selectedChildSessions = useMemo(
    () =>
      selectedSessionId
        ? availableSessions.filter(
            (session) => session.parentSessionId === selectedSessionId
          )
        : [],
    [availableSessions, selectedSessionId]
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

  // Auto-expand right pane when agent needs user approval
  useEffect(() => {
    if (
      isRightPaneCollapsed &&
      (pendingToolEvents.length > 0 ||
        visiblePermissionRequests(eventsResponse.permissions).length > 0)
    ) {
      setIsRightPaneCollapsed(false);
    }
  }, [
    pendingToolEvents,
    eventsResponse.permissions,
    isRightPaneCollapsed,
  ]);

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
  const selectedSessionIsWorking = useMemo(
    () => sessionResponseIsWorking(eventsResponse),
    [eventsResponse]
  );
  const isAgentWorking = isSubmitting || isContinuing || selectedSessionIsWorking;
  const isPromptLocked = isAgentWorking || isStopping || pendingToolEvents.length > 0;
  const floatAgentStatus = useMemo(
    () =>
      deriveFloatAgentStatus({
        session: selectedSession,
        eventsResponse,
        isWorking: isAgentWorking || isStopping,
        allowedAttachmentKinds
      }),
    [allowedAttachmentKinds, eventsResponse, isAgentWorking, isStopping, selectedSession]
  );

  useEffect(() => {
    saveFloatAgentStatus(floatAgentStatus);
  }, [floatAgentStatus]);

  useEffect(() => {
    if (selectedSessionIsWorking && !isSubmitting && !isContinuing) {
      setNotice({ tone: "info", text: t("notice.agentWorking") });
    }
  }, [isContinuing, isSubmitting, selectedSessionIsWorking, t]);

  useLayoutEffect(() => {
    if (shouldStickToTimelineBottomRef.current) {
      timelineEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [latestEventId, streamingEventId]);

  function handleTimelineScroll() {
    const timeline = timelineScrollRef.current;
    if (!timeline) {
      return;
    }
    const distanceFromBottom =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    shouldStickToTimelineBottomRef.current = distanceFromBottom < 36;
  }

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
    if (!isShellModeMenuOpen) {
      return;
    }

    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      if (!shellModeMenuRef.current?.contains(event.target as Node)) {
        setIsShellModeMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsShellModeMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isShellModeMenuOpen]);

  useEffect(() => {
    if (isPromptLocked || selectedSessionId) {
      setIsModelMenuOpen(false);
    }
  }, [isPromptLocked, selectedSessionId]);

  useEffect(() => {
    if (isPromptLocked) {
      setIsShellModeMenuOpen(false);
    }
  }, [isPromptLocked]);

  async function bootstrap() {
    setIsBooting(true);
    try {
      const configResult = await loadProviderConfig(projectRoot).catch((configError: unknown) => {
        const msg = errorMessage(configError);
        setSetupError(
          msg.includes("CONFIG_NOT_FOUND")
            ? t("setup.configNotFound")
            : t("setup.configParseError")
        );
        setNeedsSetup(true);
        return null;
      });
      if (!configResult) {
        return;
      }
      const config = configResult;
      const [nextSessions, policy] = await Promise.all([
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
      setNotice({ tone: "success", text: t("notice.workspaceLoaded") });
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
      setNotice({ tone: "success", text: t("notice.settingsSaved") });
    } catch (error) {
      reportError(error);
      throw error;
    } finally {
      setIsSavingConfig(false);
    }
  }

  async function handleSetupComplete(content: string) {
    setIsSetupSaving(true);
    try {
      const config = await saveProviderConfig(content, projectRoot);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      const preferredProviderId = preferredConfigProviderId(config);
      if (preferredProviderId) {
        setSelectedProviderId(preferredProviderId);
      }
      setNeedsSetup(false);
      setSetupError("");
      const [nextSessions, policy] = await Promise.all([
        listSessions(),
        loadShellPolicy()
      ]);
      setSessions(nextSessions);
      setShellPolicy(policy);
      setSelectedSessionId("");
      setEventsResponse(EMPTY_EVENTS);
      setStreamingEventId(null);
      setNotice({ tone: "success", text: t("notice.configCreated") });
    } catch (error) {
      setSetupError(errorMessage(error));
    } finally {
      setIsSetupSaving(false);
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
      setNotice({ tone: "error", text: t("notice.sessionProviderMissing") });
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
      setNotice({
        tone: "success",
        text: t("notice.filesIndexed", { count: nextFiles.length })
      });
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
      throw new Error(t("error.providerMissing"));
    }
    if (!projectRoot.trim()) {
      throw new Error(t("error.selectProject"));
    }
    if (selectedSession) {
      if (
        selectedSession.mode !== mode ||
        selectedSession.shellMode !== shellMode ||
        selectedSession.providerId !== selectedProviderId
      ) {
        const updated = await updateSessionMode({
          sessionId: selectedSession.id,
          mode,
          shellMode,
          providerId: selectedProviderId
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
      setNotice({ tone: "success", text: t("notice.sessionCreated") });
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
    await addPromptAttachments(selectedFiles);
  }

  async function addPromptAttachments(files: File[]) {
    if (!files.length) {
      return;
    }
    if (!selectedProviderId || !canUploadAttachments) {
      setNotice({ tone: "error", text: t("notice.attachmentsUnsupported") });
      return;
    }
    try {
      const nextAttachments = await Promise.all(
        files.map((file) => readPromptAttachment(file, allowedAttachmentKinds))
      );
      setPromptAttachments((current) => [...current, ...nextAttachments]);
      setNotice({
        tone: "success",
        text: t("notice.attachmentsAdded", { count: nextAttachments.length })
      });
    } catch (error) {
      reportError(error);
    }
  }

  function handlePromptPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    if (isPromptLocked) {
      return;
    }
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    void addPromptAttachments(files);
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
    shouldStickToTimelineBottomRef.current = true;
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsSubmitting(true);
    setNotice({ tone: "info", text: t("notice.agentWorking") });
    try {
      const session = await ensureSession();
      const previousMaxSeq = eventsResponse.events.at(-1)?.seq ?? 0;
      const selectedFileText = Array.from(selectedPaths).sort().join("\n");
      const finalPrompt = selectedFileText
        ? `${prompt.trim() || t("prompt.continueFromAttachment")}\n\n${t("prompt.selectedFiles")}\n${selectedFileText}`
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
          ? t("notice.waitingCommand")
          : t("notice.agentEnded")
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
    shouldStickToTimelineBottomRef.current = true;

    const planText = valueAsString(planEvent.data.text).trim();
    if (!planText) {
      setNotice({ tone: "error", text: t("notice.noPlanContent") });
      return;
    }

    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsSubmitting(true);
    setNotice({ tone: "info", text: t("notice.executingPlan") });
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
          ? t("notice.waitingCommand")
          : t("notice.planExecutionEnded")
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
    setNotice({ tone: "info", text: t("notice.stoppingAgent") });
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
        setNotice({ tone: "success", text: i18n.t("notice.agentStopped") });
      }
    } catch (error) {
      setIsStopping(false);
      reportError(error);
    }
  }

  async function handleApprove(eventId: string) {
    shouldStickToTimelineBottomRef.current = true;
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsMutating(true);
    setIsContinuing(true);
    setNotice({ tone: "info", text: t("notice.agentContinuing") });
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
            ? t("notice.waitingCommand")
            : t("notice.agentEnded")
        });
      } else {
        applyEventRecord(approvedEvent);
        setNotice({ tone: "success", text: t("notice.commandApproved") });
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
      setNotice({ tone: "success", text: t("notice.commandRejected") });
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
      setNotice({
        tone: reply === "reject" ? "error" : "success",
        text: t("notice.permissionHandled")
      });
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
      setNotice({ tone: "success", text: t("notice.jobStopped") });
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
    await handleRollbackMany([snapshotId], t("notice.snapshotRolledBack"));
  }

  async function handleRollbackMany(snapshotIds: string[], successText: string) {
    if (rollbackInFlightRef.current) {
      return;
    }
    if (!snapshotIds.length) {
      setNotice({ tone: "info", text: t("notice.noRollbackChanges") });
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
      setNotice({ tone: "success", text: t("notice.contextCompacted") });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleRecoverAgent(actionId: string) {
    if (actionId === "settings") {
      setIsSettingsOpen(true);
      return;
    }
    if (!selectedSessionId || isPromptLocked) {
      return;
    }
    shouldStickToTimelineBottomRef.current = true;
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsContinuing(true);
    setIsMutating(true);
    const checkpointId = checkpointIdFromAction(actionId);
    setNotice({
      tone: "info",
      text: checkpointId
        ? t("notice.recoveringCheckpoint")
        : actionId === "retry"
          ? t("notice.retrying")
          : t("notice.agentContinuing")
    });
    try {
      if (actionId === "compact") {
        const summary = await compactSession(selectedSessionId);
        applyRealtimeEvent({
          version: 1,
          kind: "context.summary.created",
          sessionId: summary.sessionId,
          seq: summary.recentEventSeq,
          summary
        });
        scheduleRealtimeTailRefresh(selectedSessionId);
      }
      const response = checkpointId
        ? await recoverSessionFromCheckpoint({
            sessionId: selectedSessionId,
            checkpointId
          })
        : await continueSession(selectedSessionId);
      if (activeRunIdRef.current !== runId) {
        return;
      }
      setEventsResponse(response);
      await refreshSessions();
      setNotice({
        tone: "success",
        text: hasUnresolvedPendingTools(response.events)
          ? t("notice.waitingCommand")
          : t("notice.agentEnded")
      });
    } catch (error) {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      reportError(error);
      await loadEvents(selectedSessionId).catch(() => undefined);
    } finally {
      if (activeRunIdRef.current === runId) {
        setIsContinuing(false);
        setIsMutating(false);
      }
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

  function selectShellMode(nextShellMode: ShellMode) {
    setShellMode(nextShellMode);
    setIsShellModeMenuOpen(false);
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
  }

  function selectAgentMode(nextMode: AgentMode) {
    setMode(nextMode);
    setIsShellModeMenuOpen(false);
    if (selectedSessionId) {
      void updateSessionMode({ sessionId: selectedSessionId, mode: nextMode })
        .then((updated) =>
          setSessions((current) =>
            current.map((session) => (session.id === updated.id ? updated : session))
          )
        )
        .catch(reportError);
    }
  }

  function selectProviderForCurrentSession(providerId: string) {
    setSelectedProviderId(providerId);
    setIsModelMenuOpen(false);
    if (selectedSessionId) {
      void updateSessionMode({
        sessionId: selectedSessionId,
        providerId
      })
        .then((updated) =>
          setSessions((current) =>
            current.map((session) => (session.id === updated.id ? updated : session))
          )
        )
        .catch(reportError);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    const session = sessions.find((item) => item.id === sessionId);
    const confirmed = window.confirm(
      t("notice.deleteSessionConfirm", { title: session?.title ?? sessionId })
    );
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
      setNotice({ tone: "success", text: t("notice.sessionDeleted") });
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
      setNotice({ tone: "error", text: t("notice.sessionTitleEmpty") });
      return;
    }

    setIsMutating(true);
    try {
      await updateSessionTitle({ sessionId, title });
      await refreshSessions();
      cancelEditingSession();
      setNotice({ tone: "success", text: t("notice.sessionTitleUpdated") });
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
      const maxLeftWidth = Math.max(260, Math.min(620, window.innerWidth - 360));
      const nextWidth = Math.min(
        maxLeftWidth,
        Math.max(260, startWidth + moveEvent.clientX - startX)
      );
      setLeftWidth(nextWidth);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function renderSessionManager() {
    return (
      <>
        <button
          className="commandButton"
          disabled={
            isCreatingSession ||
            isAgentWorking ||
            !selectedProviderId ||
            !projectRoot.trim()
          }
          onClick={() =>
            void createCurrentSession()
              .then(() => setIsSessionsOpen(false))
              .catch(() => undefined)
          }
        >
          {isCreatingSession ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
          {t("session.new")}
        </button>
        <div className="stackList sessionManagerList">
          {orderedSessions.map((session) => (
            <div
              key={session.id}
              className={`listRow ${
                session.id === selectedSessionId ? "active" : ""
              } ${session.parentSessionId ? "childSession" : ""}`}
            >
              {session.parentSessionId ? <OdodBotIcon size={15} /> : <Clock3 size={15} />}
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
                  onClick={() =>
                    void selectSession(session).then(() => setIsSessionsOpen(false))
                  }
                  onDoubleClick={() => startEditingSession(session)}
                >
                  <strong>{session.title}</strong>
                  <small>
                    {session.parentSessionId ? t("common.subAgent") : modeLabel(session.mode)} /{" "}
                    {shellModeLabel(session.shellMode)}
                  </small>
                </button>
              )}
              <button
                type="button"
                className="rowIconAction"
                aria-label={t("nav.renameSession", { title: session.title })}
                disabled={editingSessionId === session.id || isMutating || isAgentWorking}
                onClick={() => startEditingSession(session)}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="rowIconAction danger"
                aria-label={t("nav.deleteSession", { title: session.title })}
                disabled={isMutating || isAgentWorking}
                onClick={() => void handleDeleteSession(session.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!availableSessions.length && <EmptyLine text={t("empty.noAvailableSessions")} />}
        </div>
      </>
    );
  }

  return (
    <div
      className="appShell"
      style={{
        gridTemplateColumns: `${leftWidth}px 6px minmax(0, 1fr) ${isRightPaneCollapsed ? 0 : 344}px`
      }}
    >
      <aside className="leftPane">
        <header className="brandRow" onClick={async () => {
                  const mainWin = getCurrentWindow();
                  const floatWin = await WebviewWindow.getByLabel("float");
                  await floatWin?.show();
                  await mainWin.hide();
                }}>
          <span className="brandIcon">
            <OdodBotIcon size={22} />
          </span>
          <span>
            <strong>oDot</strong>
            <small>{t("brand.tagline")}</small>
          </span>
        </header>

        <section className="leftSection providerConfigSection">
          <div className="sectionTitleRow">
            <SectionTitle icon={<KeyRound size={16} />} title={t("nav.aiService")} />
            <div className="sectionActions">
              <button
                className="iconButton ghost"
                aria-label={t("nav.manageSessions")}
                title={t("nav.manageSessions")}
                onClick={() => setIsSessionsOpen(true)}
              >
                <MessageSquare size={16} />
              </button>
              <button
                className="iconButton ghost"
                aria-label={t("nav.openSettings")}
                title={t("nav.openSettings")}
                onClick={() => setIsSettingsOpen(true)}
              >
                <Settings size={16} />
              </button>
            </div>
          </div>
        </section>

        <section className="leftSection projectSection">
          <SectionTitle icon={<FolderOpen size={16} />} title={t("nav.projectFiles")} />
          <div className="pathRow">
            <input
              value={projectRoot}
              onChange={(event) => setProjectRoot(event.target.value)}
              placeholder={t("nav.projectRoot")}
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
              placeholder={t("nav.filterFiles")}
            />
          </div>
          <div className="fileTree" aria-label={t("nav.fileTree")}>
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
            {!files.length && <EmptyLine text={t("empty.noIndexedFiles")} />}
          </div>
        </section>

      </aside>

      <div
        className="resizeHandle"
        onPointerDown={startLeftResize}
        role="separator"
        aria-label={t("nav.resizeSidebar")}
      />

      <main className="mainPane">
        <section className="timelinePane">
          <div className="timeline" ref={timelineScrollRef} onScroll={handleTimelineScroll}>
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
                void handleRollbackMany(snapshotIds, successText ?? t("notice.rolledBackBeforePrompt"))
              }
              onRecoverAgent={handleRecoverAgent}
            />
            {!eventsResponse.events.length && (
              <div className="emptyTimeline">
                <BrainCircuit size={28} />
                <span>{t("empty.startPrompt")}</span>
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
                onPaste={handlePromptPaste}
                placeholder={
                  isAgentWorking
                    ? t("prompt.agentWorking")
                    : isStopping
                      ? t("prompt.agentStopping")
                      : pendingToolEvents.length
                        ? t("prompt.pendingCommands")
                        : t("prompt.followUp")
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
                <div className="promptAttachmentList" aria-label={t("nav.uploadedAttachments")}>
                  {promptAttachments.map((attachment) => (
                    <span className="promptAttachmentChip" key={attachment.id}>
                      <span>{attachment.name}</span>
                      <small>
                        {attachment.kind === "image" ? t("common.image") : t("common.text")} ·{" "}
                        {formatBytes(attachment.size)}
                      </small>
                      <button
                        type="button"
                        aria-label={t("nav.removeAttachment", { name: attachment.name })}
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
                        : t("session.selectModelFirst")
                    }
                    aria-label={t("nav.uploadAttachment")}
                    disabled={isPromptLocked || !selectedProviderId || !canUploadAttachments}
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    <Plus size={18} />
                  </button>
                  <div
                    ref={modelMenuRef}
                    className="composerModelSelect"
                    title={t("nav.selectModel")}
                  >
                    <button
                      type="button"
                      className="composerModelButton"
                      disabled={isPromptLocked}
                      aria-haspopup="listbox"
                      aria-expanded={isModelMenuOpen}
                      aria-label={t("nav.selectModel")}
                      onClick={() => setIsModelMenuOpen((open) => !open)}
                    >
                      <span>{selectedProvider ? selectedModelLabel : t("empty.noModelConfigured")}</span>
                      <ChevronDown size={15} />
                    </button>
                    {isModelMenuOpen && !isPromptLocked && (
                      <div className="composerModelMenu" role="listbox" aria-label={t("nav.selectModel")}>
                        {!providers.length && (
                          <div className="composerModelEmpty">{t("empty.noModelConfigured")}</div>
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
                              onClick={() => selectProviderForCurrentSession(provider.id)}
                            >
                              <span>{providerModelLabel(provider)}</span>
                              {isSelected && <Check size={15} />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  </div>
                <div
                  ref={shellModeMenuRef}
                  className="composerRunConfigSelect"
                  title={`${modeLabel(mode)} / ${shellModeLabel(shellMode)}`}
                >
                  <button
                    type="button"
                    className="composerRunConfigButton"
                    disabled={isPromptLocked}
                    aria-haspopup="listbox"
                    aria-expanded={isShellModeMenuOpen}
                    aria-label={`${modeLabel(mode)} / ${shellModeLabel(shellMode)}`}
                    onClick={() => setIsShellModeMenuOpen((open) => !open)}
                  >
                    <span>{modeLabel(mode)}</span>
                    <small>{t(`shellMode.${shellMode}`)}</small>
                    <ChevronDown size={14} />
                  </button>
                  {isShellModeMenuOpen && !isPromptLocked && (
                    <div
                      className="composerRunConfigMenu"
                      role="listbox"
                      aria-label={`${modeLabel(mode)} / ${shellModeLabel(shellMode)}`}
                    >
                      <div className="composerRunConfigColumn">
                        <strong>{t("nav.runMode")}</strong>
                        {(["ask", "plan", "agent"] as AgentMode[]).map((item) => {
                          const isSelected = item === mode;
                          return (
                            <button
                              type="button"
                              key={item}
                              className={`composerRunConfigOption ${isSelected ? "active" : ""}`}
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => selectAgentMode(item)}
                            >
                              <span>{modeLabel(item)}</span>
                              {isSelected && <Check size={14} />}
                            </button>
                          );
                        })}
                      </div>
                      <div className="composerRunConfigColumn">
                        <strong>{t("nav.commandApproval")}</strong>
                        {(["manual", "auto"] as ShellMode[]).map((item) => {
                          const isSelected = item === shellMode;
                          return (
                            <button
                              type="button"
                              key={item}
                              className={`composerRunConfigOption ${isSelected ? "active" : ""}`}
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => selectShellMode(item)}
                            >
                              <span>{t(`shellMode.${item}`)}</span>
                              {isSelected && <Check size={14} />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <div className={`composerSubmitCapsule ${isAgentWorking ? "stop" : ""}`}>
                  <div className="promptNavGroup">
                    <button
                      type="button"
                      className="promptNavIconButton"
                      title={t("nav.prevPrompt")}
                      aria-label={t("nav.prevPrompt")}
                      disabled={!promptEventCount}
                      onClick={() => scrollToPrompt("previous")}
                    >
                      <ChevronUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="promptNavIconButton"
                      title={t("nav.nextPrompt")}
                      aria-label={t("nav.nextPrompt")}
                      disabled={!promptEventCount}
                      onClick={() => scrollToPrompt("next")}
                    >
                      <ChevronDown size={15} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="composerSendButton"
                    aria-label={isAgentWorking ? t("nav.stopAgent") : t("nav.sendPrompt")}
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
                    {isAgentWorking ? <Square size={16} /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <button
        className="rightPaneToggle"
        type="button"
        aria-label={isRightPaneCollapsed ? t("nav.expandRightPane") : t("nav.collapseRightPane")}
        onClick={() => setIsRightPaneCollapsed((current) => !current)}
      >
        {isRightPaneCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      <aside className={`rightPane ${isRightPaneCollapsed ? "collapsed" : ""}`}>

        {!isRightPaneCollapsed && (
          <>
            <section className="rightSection">
              <SectionTitle icon={<Database size={16} />} title={t("nav.contextInfo")} />
              <ContextUsageMeter usage={contextUsage} />
              <strong>{selectedSession?.title ?? t("empty.noActiveSession")}</strong>
              <small>
                {selectedProvider ? selectedModelLabel : t("session.noServiceSelected")} /{" "}
                {t("session.selectedFiles", { count: selectedPaths.size })}
              </small>
              {selectedChildSessions.length > 0 && (
                <small className="subagentStatus">
                  {t("session.subAgentStatus", {
                    total: selectedChildSessions.length,
                    active: selectedChildSessions.filter((session) => session.status === "active")
                      .length
                  })}
                </small>
              )}
              <button
                className="iconTextButton"
                disabled={!selectedSessionId || isMutating}
                onClick={() => void handleCompact()}
              >
                <Database size={16} />
                {t("nav.compactContext")}
              </button>
            </section>

            {lastError && (
              <section className="rightSection errorSection">
                <SectionTitle icon={<AlertTriangle size={16} />} title={t("nav.errorDetails")} />
                <pre className="errorDetails">{lastError}</pre>
                <button className="iconTextButton" onClick={() => setLastError(null)}>
                  <X size={16} />
                  {t("common.clear")}
                </button>
              </section>
            )}

            <section className="rightSection">
              <SectionTitle icon={<Terminal size={16} />} title={t("nav.commandApproval")} />
              <div className="stackList">
                {pendingToolEvents.map((event) => (
                  <div className="approvalRow" key={event.id}>
                    <code>{pendingCommand(event)}</code>
                    <div>
                  <button
                    className="iconButton success"
                    disabled={isMutating}
                    onClick={() => void handleApprove(event.id)}
                    title={t("common.accept")}
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="iconButton trust"
                    disabled={isMutating}
                    onClick={() => void handleApproveAndAllow(event)}
                    title={t("common.acceptAndAllowlist")}
                  >
                    <Save size={16} />
                  </button>
                  <button
                    className="iconButton danger"
                    disabled={isMutating}
                    onClick={() => void handleReject(event.id)}
                    title={t("common.reject")}
                  >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {!pendingToolEvents.length && <EmptyLine text={t("empty.noPendingCommands")} />}
              </div>
            </section>

            <section className="rightSection">
              <SectionTitle icon={<KeyRound size={16} />} title={t("nav.permissionRequests")} />
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
                          title={t("common.allowOnce")}
                        >
                          <Check size={16} />
                        </button>
                        <button
                          className="iconButton trust"
                          disabled={isMutating}
                          onClick={() => void handlePermissionReply(request.id, "always")}
                          title={t("common.allowAlways")}
                        >
                          <Save size={16} />
                        </button>
                        <button
                          className="iconButton danger"
                          disabled={isMutating}
                          onClick={() => void handlePermissionReply(request.id, "reject")}
                          title={t("common.reject")}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                {!visiblePermissionRequests(eventsResponse.permissions).length && (
                  <EmptyLine text={t("empty.noPermissionRequests")} />
                )}
              </div>
            </section>

            <section className="rightSection">
              <SectionTitle icon={<Clock3 size={16} />} title={t("nav.backgroundJobs")} />
              <div className="stackList">
                {visibleJobs.map((job) => (
                  <div className="approvalRow" key={job.id}>
                    <code>{job.status} #{job.pid} {job.command}</code>
                    <button
                      className="iconButton danger"
                      disabled={isMutating || job.status !== "running"}
                      onClick={() => void handleCancelJob(job.id)}
                      title={t("nav.stopJob")}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                {!visibleJobs.length && <EmptyLine text={t("empty.noBackgroundJobs")} />}
              </div>
            </section>

          </>
        )}
      </aside>

      {needsSetup && (
        <SetupDialog
          error={setupError}
          isSaving={isSetupSaving}
          projectRoot={projectRoot}
          onComplete={handleSetupComplete}
        />
      )}
      {isSettingsOpen && (
        <SettingsModal
          configPath={configPath}
          configContent={configContent}
          providers={providers}
          selectedProviderId={selectedProviderId}
          shellPolicy={shellPolicy}
          themeMode={themeMode}
          locale={(i18n.language === "en" ? "en" : "zh") as AppLocale}
          isSaving={isSavingConfig}
          onThemeModeChange={setThemeMode}
          onLocaleChange={(nextLocale) => void setAppLocale(nextLocale)}
          onClose={() => setIsSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
      {isSessionsOpen && (
        <SessionsModal
          sessionCount={availableSessions.length}
          onClose={() => {
            cancelEditingSession();
            setIsSessionsOpen(false);
          }}
        >
          {renderSessionManager()}
        </SessionsModal>
      )}
    </div>
  );
}

function SessionsModal({
  children,
  sessionCount,
  onClose
}: {
  children: ReactNode;
  sessionCount: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modalBackdrop" role="presentation">
      <section className="settingsModal sessionsModal" role="dialog" aria-modal="true">
        <header className="modalHeader">
          <div>
            <strong>{t("session.manage")}</strong>
            <small>
              {sessionCount
                ? t("session.availableCount", { count: sessionCount })
                : t("empty.noAvailableSessions")}
            </small>
          </div>
          <button className="iconButton ghost" onClick={onClose} aria-label={t("session.closeManager")}>
            <X size={16} />
          </button>
        </header>
        <div className="sessionsModalBody">{children}</div>
      </section>
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
  locale,
  isSaving,
  onThemeModeChange,
  onLocaleChange,
  onClose,
  onSave
}: {
  configPath: string;
  configContent: string;
  providers: ProviderRecord[];
  selectedProviderId: string;
  shellPolicy: ShellPolicy;
  themeMode: ThemeMode;
  locale: AppLocale;
  isSaving: boolean;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: AppLocale) => void;
  onClose: () => void;
  onSave: (content: string, policy: ShellPolicy) => Promise<void>;
}) {
  const { t } = useTranslation();
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
            <strong>{t("settings.title")}</strong>
            <small>{configPath || t("settings.configNotLoaded")}</small>
          </div>
          <button className="iconButton ghost" onClick={onClose} aria-label={t("settings.close")}>
            <X size={16} />
          </button>
        </header>

        <div className="settingsBody">
          {error && <pre className="modalError">{error}</pre>}

          <div className="settingsGrid">
            <label>
              <span>{t("settings.provider")}</span>
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
              <span>{t("settings.model")}</span>
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
              <span>{t("settings.name")}</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>{t("settings.baseUrl")}</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label className="settingsWide">
              <span>{t("settings.apiKey")}</span>
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                type="password"
              />
            </label>
            <label className="settingsWide">
              <span>{t("locale.label")}</span>
              <Segmented
                value={locale}
                options={[
                  ["zh", t("locale.zh")],
                  ["en", t("locale.en")]
                ]}
                onChange={(value) => onLocaleChange(value as AppLocale)}
              />
            </label>
            <label className="settingsWide">
              <span>{t("theme.label")}</span>
              <Segmented
                value={themeMode}
                options={[
                  ["system", t("theme.system")],
                  ["light", t("theme.light")],
                  ["dark", t("theme.dark")]
                ]}
                onChange={(value) => onThemeModeChange(value as ThemeMode)}
              />
            </label>
            <label className="settingsWide">
              <span>{t("settings.autoAllowlist")}</span>
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
            {t("settings.advancedJson")}
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
            {t("common.cancel")}
          </button>
          <button
            className="commandButton modalSaveButton"
            disabled={isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t("common.save")}
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

type RecoveryAction = {
  id: string;
  label: string;
  description?: string;
};

type TimelineErrorInfo = {
  id?: string;
  kind: string;
  message: string;
  checkpointId?: string;
  causes: string[];
  retryable: boolean;
  recoverable: boolean;
  suggestedActions: RecoveryAction[];
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
  errorInfo?: TimelineErrorInfo;
  codeChange?: TimelineCodeChange;
  codeChangeGroup?: TimelineCodeChangeGroup;
  rollbackSnapshotIds?: string[];
};

function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const { t } = useTranslation();
  const tooltipId = "context-usage-details";
  return (
    <div
      className={`contextUsage ${usage.severity}`}
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      <span>
        {t("context.usage", {
          percent: usage.percent,
          source: usage.source === "provider" ? t("context.actual") : t("context.estimate")
        })}
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
            <dt>{t("context.input")}</dt>
            <dd>{formatInteger(usage.tokens.input)}</dd>
          </div>
          <div>
            <dt>{t("context.output")}</dt>
            <dd>{formatInteger(usage.tokens.output)}</dd>
          </div>
          <div>
            <dt>{t("context.reasoning")}</dt>
            <dd>{formatInteger(usage.tokens.reasoning)}</dd>
          </div>
          <div>
            <dt>{t("context.cacheRead")}</dt>
            <dd>{formatInteger(usage.tokens.cache.read)}</dd>
          </div>
          <div>
            <dt>{t("context.cacheWrite")}</dt>
            <dd>{formatInteger(usage.tokens.cache.write)}</dd>
          </div>
          <div>
            <dt>{t("context.total")}</dt>
            <dd>{formatInteger(usage.tokens.total)}</dd>
          </div>
        </dl>
        <p>
          {usage.providerId || t("common.unknownProvider")} / {usage.model || t("common.unknownModel")}
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
  onRollbackSnapshots,
  onRecoverAgent
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
  onRecoverAgent: (actionId: string) => Promise<void>;
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
          onRecoverAgent={onRecoverAgent}
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
  onRollbackSnapshots,
  onRecoverAgent
}: {
  item: TimelineItem;
  stream: boolean;
  canExecutePlan: boolean;
  onExecutePlan: (event: EventRecord) => Promise<void>;
  rollbackDisabled: boolean;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRollbackSnapshots: (snapshotIds: string[], successText?: string) => void;
  onRecoverAgent: (actionId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const hiddenDetails = item.details.filter((event) => event.id !== item.event?.id);
  const icon = timelineItemIcon(item);
  const isReasoningItem = item.kind === "reasoning";

  return (
    <article
      className={`timelineItem ${item.kind} ${item.status}`}
      data-prompt-block={item.kind === "userPrompt" ? "true" : undefined}
    >
      {!isReasoningItem && (
        <div className="timelineItemRail">
          <div className="timelineItemIcon">{icon}</div>
        </div>
      )}
      <div className="timelineItemBody">
        {!isReasoningItem && (
          <header className="timelineItemHeader">
            <strong>{item.title}</strong>
            {item.event && <span>#{item.event.seq}</span>}
          </header>
        )}

        {item.kind === "userPrompt" && (
          <>
            {item.text && <p className="promptText">{item.text}</p>}
            {!!item.attachments?.length && (
              <div className="timelineAttachmentList" aria-label={t("timeline.promptAttachments")}>
                {item.attachments.map((attachment, index) => (
                  <span className="timelineAttachmentChip" key={`${item.id}-${index}-${attachment.name}`}>
                    {attachment.name}
                    <small>
                      {attachment.kind === "image" ? t("common.image") : t("common.text")} ·{" "}
                      {formatBytes(attachment.size)}
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
                title={t("timeline.rollbackBeforePromptTitle")}
              >
                <RotateCcw size={15} />
                {t("timeline.rollbackBeforePrompt")}
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
                {t("timeline.executePlan")}
              </button>
            )}
          </div>
        )}

        {item.kind === "reasoning" && (
          <details className="reasoningBlock">
            <summary>
              <BrainCircuit size={15} />
              <span>{t("timeline.reasoning")}</span>
              <ChevronRight size={13} className="reasoningClosedIcon" />
              <ChevronDown size={13} className="reasoningOpenIcon" />
            </summary>
            <MarkdownText text={item.text ?? ""} />
          </details>
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

        {item.errorInfo && (
          <ErrorRecoveryCard
            error={item.errorInfo}
            disabled={rollbackDisabled}
            onRecover={onRecoverAgent}
          />
        )}

        {!isReasoningItem && item.hiddenSummary && (
          <div className="hiddenSummary">
            <Wrench size={13} />
            <span>{item.hiddenSummary}</span>
          </div>
        )}
        {!isReasoningItem && <HiddenDetails events={hiddenDetails} />}
      </div>
    </article>
  );
}

function ErrorRecoveryCard({
  error,
  disabled,
  onRecover
}: {
  error: TimelineErrorInfo;
  disabled: boolean;
  onRecover: (actionId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const actions = error.suggestedActions.length
    ? error.suggestedActions
    : [
        {
          id: "continue",
          label: t("common.continue"),
          description: t("timeline.continueDesc")
        }
      ];
  return (
    <div className="errorRecoveryCard">
      <div className="errorRecoveryMeta">
        <span>{errorKindLabel(error.kind)}</span>
        <span>{error.retryable ? t("timeline.retryable") : t("timeline.notRetryable")}</span>
        <span>{error.recoverable ? t("timeline.recoverable") : t("timeline.notRecoverable")}</span>
      </div>
      {error.causes.length > 0 && (
        <details className="errorCauseChain">
          <summary>
            <ChevronRight size={13} />
            {t("timeline.errorChain")}
          </summary>
          <ol>
            {error.causes.map((cause, index) => (
              <li key={`${error.id ?? error.message}-${index}`}>{cause}</li>
            ))}
          </ol>
        </details>
      )}
      <div className="errorRecoveryActions">
        {actions.map((action) => (
          <button
            type="button"
            className="iconTextButton"
            key={action.id}
            disabled={disabled}
            title={
              checkpointIdFromAction(action.id)
                ? appT("recover.checkpointDesc")
                : recoveryActionDescription(action.id, action.description ?? "")
            }
            onClick={() => void onRecover(action.id)}
          >
            {action.id === "settings" ? (
              <Settings size={15} />
            ) : action.id === "compact" ? (
              <Database size={15} />
            ) : checkpointIdFromAction(action.id) ? (
              <History size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            {checkpointIdFromAction(action.id)
              ? appT("recover.checkpoint")
              : recoveryActionLabel(action.id, action.label)}
          </button>
        ))}
      </div>
    </div>
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
  const { t } = useTranslation();
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
              onRollbackSnapshots(rollbackSnapshotIds, t("notice.rolledBackFileChange"));
              return;
            }
            onRollbackSnapshot(rollbackSnapshotIds[0]);
          }}
          title={
            rollbackDisabledState ? t("timeline.noSnapshot") : t("timeline.rollbackChangeTitle")
          }
        >
          <RotateCcw size={15} />
          {t("timeline.rollbackChange")}
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
  const { t } = useTranslation();
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
          <span>{t("timeline.modifiedFiles", { count: group.stats.files })}</span>
          <b className="patchStat add">+{group.stats.added}</b>
          <b className="patchStat del">-{group.stats.deleted}</b>
        </button>
        <button
          type="button"
          className="inlineRollbackButton"
          disabled={rollbackDisabledState}
          onClick={() => onRollbackSnapshots(group.rollbackSnapshotIds, t("notice.rolledBackRound"))}
          title={
            rollbackDisabledState ? t("timeline.noRoundSnapshot") : t("timeline.rollbackRoundTitle")
          }
        >
          <RotateCcw size={15} />
          {t("timeline.rollbackRound")}
        </button>
      </div>
      <div className="codeChangeSummaryMeta">
        <span>{operationSummary(group.changes)}</span>
        {previewChanges.map((change) => (
          <code key={change.id}>{change.path}</code>
        ))}
        {overflowCount > 0 && <span>{t("timeline.moreFiles", { count: overflowCount })}</span>}
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
  const { t } = useTranslation();
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
        {t("common.viewDetails")}
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
  const { t } = useTranslation();
  const normalizedText = useMemo(() => normalizeInlineMarkdownTables(text), [text]);
  const isLong = isLongMarkdown(normalizedText);
  const [expanded, setExpanded] = useState(!isLong);
  const [visibleLength, setVisibleLength] = useState(stream ? 0 : text.length);

  useEffect(() => {
    setExpanded(!isLongMarkdown(normalizedText));
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
  }, [normalizedText, stream, text]);

  const displayText = stream
    ? Array.from(text).slice(0, visibleLength).join("")
    : normalizedText;
  const markdownText = stream ? normalizeInlineMarkdownTables(displayText) : displayText;

  return (
    <div className={`markdownFrame ${isLong && !expanded ? "collapsed" : ""}`}>
      <div className="markdownBody">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: ({ children, ...props }) => (
              <div className="markdownTableScroll">
                <table {...props}>{children}</table>
              </div>
            )
          }}
        >
          {markdownText}
        </ReactMarkdown>
      </div>
      {isLong && (
        <button
          type="button"
          className="collapseToggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t("common.collapse") : t("common.expand")}
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

function normalizeInlineMarkdownTables(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => normalizeInlineMarkdownTableLine(line))
    .join("\n");
}

function normalizeInlineMarkdownTableLine(line: string) {
  if (!line.includes("|")) {
    return line;
  }

  const rows = line
    .replace(/\|\s+(?=\|)/g, "|\n")
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length < 2 || !rows.every(isMarkdownTableRow)) {
    return line;
  }

  const separatorIndex = rows.findIndex(isMarkdownTableSeparatorRow);
  if (separatorIndex !== 1) {
    return line;
  }

  return rows.join("\n");
}

function isMarkdownTableRow(row: string) {
  return row.startsWith("|") && row.endsWith("|") && row.slice(1, -1).includes("|");
}

function isMarkdownTableSeparatorRow(row: string) {
  if (!isMarkdownTableRow(row)) {
    return false;
  }
  return row
    .slice(1, -1)
    .split("|")
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
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
        appT("execution.execFailed");
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
  const { t } = useTranslation();
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
          <strong>{t("execution.title")}</strong>
          <span className={summary.status}>{summary.statusText}</span>
        </div>
        <small>{summary.detail}</small>
      </button>
      <div className="executionSummary">
        <span>
          <Wrench size={14} />
          {t("execution.tools")} {summary.toolCount}
        </span>
        <span>{t("execution.reads")} {summary.readCount}</span>
        <span>{t("execution.searches")} {summary.searchCount}</span>
        <span>{t("execution.commands")} {summary.commandCount}</span>
        <span>{t("execution.changes")} {summary.changeCount}</span>
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
          {!details.length && <div className="dockDetailItem empty">{t("empty.noToolCalls")}</div>}
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
      title: appT("timeline.codeChange"),
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
        title: appT("event.prompt.submitted"),
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
          title: appT("event.assistant.message"),
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
          title: appT("timeline.reasoning"),
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
        title: appT("event.assistant.message"),
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
        title: appT("timeline.reasoning"),
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
      title: appT("timeline.runDetails"),
      text: summarizeHiddenEvents(hiddenBuffer) || appT("timeline.lowPriorityEvents"),
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
  const path = valueAsString(result.path) || appT("timeline.unknownFile");
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
      ? appT("operation.add")
      : last.afterContent === null
        ? appT("operation.delete")
        : appT("operation.modifyTimes", { count: sorted.length });

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
    return appT("operation.delete");
  }
  if (snapshot?.beforeContent === null) {
    return appT("operation.add");
  }
  const key = `tool.${toolName}`;
  const translated = appT(key);
  return translated === key ? appT("operation.modify") : translated;
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
      title: appT("event.waitingApproval"),
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
      title: appT("event.toolFailed"),
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
      title: appT("event.toolRejected"),
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
      title: appT("event.policy.blocked"),
      text: valueAsString(event.data.reason) || appT("status.policyBlockedDefault"),
      status: "failed",
      event,
      details: [event]
    };
  }
  if (event.type === "step.failed") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: appT("status.executionFailed"),
      text: valueAsString(event.data.error),
      status: "failed",
      event,
      details: [event]
    };
  }
  if (event.type === "agent.failed") {
    const errorInfo = timelineErrorInfo(event);
    return {
      id: event.id,
      kind: "statusSummary",
      title: appT("status.runFailed"),
      text: errorInfo.message || valueAsString(event.data.message) || eventLabel(event),
      status: "failed",
      event,
      details: [event],
      errorInfo
    };
  }
  if (event.type === "agent.cancelRequested" || event.type === "agent.stopped") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: event.type === "agent.stopped" ? appT("status.stopped") : appT("event.agent.cancelRequested"),
      text: valueAsString(event.data.reason) || eventLabel(event),
      status: event.type === "agent.stopped" ? "done" : "waiting",
      event,
      details: [event]
    };
  }
  if (event.type === "session.checkpoint.restored") {
    return {
      id: event.id,
      kind: "statusSummary",
      title: appT("status.checkpointRestored"),
      text: valueAsString(event.data.label) || eventLabel(event),
      status: "waiting",
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
    appT("status.toolExecutionFailed")
  );
}

function timelineErrorInfo(event: EventRecord): TimelineErrorInfo {
  const error = asRecord(event.data.error);
  const checkpointId = valueAsString(event.data.checkpointId);
  const actions = Array.isArray(error.suggestedActions)
    ? error.suggestedActions
        .map(recoveryActionFromValue)
        .filter((action): action is RecoveryAction => Boolean(action))
    : [];
  const checkpointActions = checkpointId
    ? [
        {
          id: checkpointActionId(checkpointId),
          label: appT("recover.checkpoint"),
          description: appT("recover.checkpointDesc")
        }
      ]
    : [];
  return {
    id: valueAsString(error.id),
    kind: valueAsString(error.kind) || "unknown",
    message:
      valueAsString(error.message) ||
      valueAsString(event.data.message) ||
      eventFailureText(event),
    checkpointId,
    causes: stringArray(error.causes),
    retryable: Boolean(error.retryable),
    recoverable: Boolean(error.recoverable),
    suggestedActions: [...checkpointActions, ...actions]
  };
}

function checkpointActionId(checkpointId: string) {
  return `checkpoint:${checkpointId}`;
}

function checkpointIdFromAction(actionId: string) {
  return actionId.startsWith("checkpoint:") ? actionId.slice("checkpoint:".length) : "";
}

function recoveryActionFromValue(value: unknown): RecoveryAction | null {
  const record = asRecord(value);
  const id = valueAsString(record.id);
  const label = valueAsString(record.label);
  if (!id || !label) {
    return null;
  }
  return {
    id,
    label,
    description: valueAsString(record.description)
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => valueAsString(item)).filter(Boolean)
    : [];
}

function errorKindLabel(kind: string) {
  const key = `errorKind.${kind}`;
  const translated = appT(key);
  return translated === key ? kind : translated;
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
    toolCalls.length ? appT("hidden.toolCalls", { count: toolCalls.length }) : "",
    reads ? appT("hidden.reads", { count: reads }) : "",
    searches ? appT("hidden.searches", { count: searches }) : "",
    commands ? appT("hidden.commands", { count: commands }) : "",
    steps ? appT("hidden.steps", { count: steps }) : ""
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : appT("hidden.details", { count: hidden.length });
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
      ? appT("execution.failed")
      : status === "waiting"
        ? appT("execution.waiting")
        : status === "running"
          ? appT("execution.running")
          : appT("execution.done");

  return {
    status,
    statusText,
    toolCount: toolCalls.length,
    readCount,
    searchCount,
    commandCount,
    changeCount,
    detail: appT("execution.detail", { events: events.length, changes: changeCount })
  };
}

function timelineItemIcon(item: TimelineItem) {
  if (item.kind === "userPrompt") {
    return <Pencil size={16} />;
  }
  if (item.kind === "assistantReply") {
    return <OdodBotIcon size={16} />;
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
  const key = `event.${event.type}`;
  const base = appT(key);
  const label = base === key ? event.type : base;
  if (event.type.startsWith("tool.")) {
    return `${label} ${toolLabel(valueAsString(event.data.name))}`.trim();
  }
  return label;
}

function pendingCommand(event: EventRecord) {
  return (
    valueAsString((event.data.pending as Record<string, unknown> | undefined)?.command) ||
    valueAsString(event.data.command) ||
    appT("event.pendingCommand")
  );
}

function visiblePermissionRequests(requests: PermissionRequestRecord[]) {
  return requests.filter(
    (request) => request.status === "pending" && !isToolPermissionRequest(request)
  );
}

function sessionResponseIsWorking(response: SessionEventsResponse) {
  const latest = response.events.at(-1);
  if (latest && sessionEventEndsWork(latest)) {
    return false;
  }
  if (latest && sessionEventShowsWork(latest)) {
    return true;
  }
  return response.runs.some((run) => run.status === "running" && !run.endedAt);
}

function sessionEventEndsWork(event: EventRecord) {
  return (
    event.type === "agent.failed" ||
    event.type === "agent.stopped" ||
    event.type === "policy.blocked" ||
    event.type === "step.failed" ||
    event.type === "task.completed" ||
    event.type === "tool.pending" ||
    (event.type === "session.checkpoint.saved" && event.data.status !== "running") ||
    (event.type === "step.ended" && (event.data.done === true || event.data.pending === true))
  );
}

function sessionEventShowsWork(event: EventRecord) {
  return (
    (event.type === "session.checkpoint.saved" && event.data.status === "running") ||
    event.type === "session.input.admitted" ||
    event.type === "prompt.submitted" ||
    event.type === "step.started" ||
    (event.type === "step.ended" && event.data.done === false && event.data.pending !== true) ||
    event.type === "llm.stream.started" ||
    event.type === "llm.stream.finished" ||
    event.type.endsWith(".delta") ||
    event.type === "reasoning.summary" ||
    event.type === "assistant.message" ||
    event.type === "tool.called" ||
    event.type === "tool.success" ||
    event.type === "tool.failed" ||
    event.type === "tool.rejected"
  );
}

function isToolPermissionRequest(request: PermissionRequestRecord) {
  const source = asRecord(request.sourceJson);
  return source.type === "tool";
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
  return error.split("\n").find((line) => line.trim()) ?? appT("error.unknown");
}

function preferredConfigProviderId(config: ProviderConfigFileResponse) {
  return config.selectedProviderId ?? config.providers[0]?.id ?? "";
}

function latestPlanExecutionEvents(events: EventRecord[]) {
  let startIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "prompt.submitted") {
      if (valueAsString(event.data.prompt).trimStart().includes(PLAN_EXECUTION_MARKER)) {
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
  return appT(`mode.${value}`);
}

function shellModeLabel(value: ShellMode) {
  return appT(`shellMode.${value}Long`);
}

function toolLabel(value: string) {
  const key = `tool.${value}`;
  const translated = appT(key);
  return translated === key ? value : translated;
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

const CONTEXT_ESTIMATE_EVENT_LIMIT = 2_000;
const CONTEXT_ESTIMATE_TOOL_RESULT_LIMIT = 40_000;

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
    appT("contextNotes.providerSource"),
    limitIsDefault ? appT("contextNotes.defaultLimit") : ""
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
  const estimatedEvents = eventsResponse.events.slice(-CONTEXT_ESTIMATE_EVENT_LIMIT);
  const recentEventText = estimatedEvents
    .map(
      (event) =>
        `#${event.seq} ${event.type} ${truncateText(
          safeJson(event.data),
          event.type.startsWith("tool.") ? CONTEXT_ESTIMATE_TOOL_RESULT_LIMIT : 2_000
        )}`
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
      appT("contextNotes.estimateSource", {
        recent: estimatedEvents.length,
        total: eventsResponse.events.length
      }),
      limitIsDefault ? appT("contextNotes.defaultLimit") : "",
      appT("contextNotes.estimateHint")
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
    throw new Error(appT("validation.providerRequired"));
  }
  if (!modelId) {
    throw new Error(appT("validation.modelRequired"));
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

type SetupConfigFields = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelDisplayName: string;
};

function generateSetupConfig(fields: SetupConfigFields): string {
  const rawId = fields.providerName.trim().toLowerCase().replace(/\s+/g, "-");
  const providerId = rawId || "openai-compatible";
  const modelId = fields.modelId.trim();
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${providerId}/${modelId}`,
    provider: {
      [providerId]: {
        name: fields.providerName.trim() || providerId,
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: fields.baseUrl.trim() || "https://api.openai.com/v1",
          apiKey: fields.apiKey.trim()
        },
        models: {
          [modelId]: {
            name: fields.modelDisplayName.trim() || modelId
          }
        }
      }
    }
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

type SetupPreset = {
  label: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  modelDisplayName: string;
};

const SETUP_PRESETS: SetupPreset[] = [
  {
    label: "OpenAI",
    providerName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4.1-mini",
    modelDisplayName: "GPT-4.1 Mini"
  },
  {
    label: "DeepSeek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
    modelDisplayName: "DeepSeek Chat"
  },
  {
    label: "SiliconFlow",
    providerName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    modelId: "deepseek-ai/DeepSeek-V3",
    modelDisplayName: "DeepSeek V3"
  },
  {
    label: "火山引擎",
    providerName: "Volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    modelId: "ark-code-latest",
    modelDisplayName: "ark-code-latest"
  }
];

function SetupDialog({
  error,
  isSaving,
  projectRoot,
  onComplete
}: {
  error: string;
  isSaving: boolean;
  projectRoot: string;
  onComplete: (content: string) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"form" | "text">("form");
  const [opencodeContent, setOpencodeContent] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelDisplayName, setModelDisplayName] = useState("");
  const [formError, setFormError] = useState("");
  const [textImport, setTextImport] = useState("");
  const [textError, setTextError] = useState("");

  useEffect(() => {
    findOpencodeConfig(projectRoot)
      .then((content) => {
        if (content) setOpencodeContent(content);
      })
      .catch(() => {});
  }, [projectRoot]);

  function applyPreset(preset: SetupPreset) {
    setProviderName(preset.providerName);
    setBaseUrl(preset.baseUrl);
    setModelId(preset.modelId);
    setModelDisplayName(preset.modelDisplayName);
  }

  function handleGenerate() {
    setFormError("");
    if (!apiKey.trim()) {
      setFormError(t("setup.errorApiKeyRequired"));
      return;
    }
    if (!modelId.trim()) {
      setFormError(t("setup.errorModelIdRequired"));
      return;
    }
    const content = generateSetupConfig({
      providerName,
      baseUrl,
      apiKey,
      modelId,
      modelDisplayName
    });
    onComplete(content);
  }

  function handleOpencodeImport() {
    if (opencodeContent) {
      onComplete(opencodeContent);
    }
  }

  function handleTextImport() {
    setTextError("");
    const trimmed = textImport.trim();
    if (!trimmed) {
      setTextError(t("setup.invalidJsonFormat"));
      return;
    }
    try {
      const config = JSON.parse(trimmed);
      if (
        typeof config !== "object" ||
        config === null ||
        !("provider" in config)
      ) {
        setTextError(t("setup.invalidJsonFormat"));
        return;
      }
    } catch {
      setTextError(t("setup.invalidJsonFormat"));
      return;
    }
    onComplete(trimmed);
  }

  return (
    <div className="modalBackdrop" role="presentation">
      <section className="settingsModal setupDialog" role="dialog" aria-modal="true">
        <header className="modalHeader">
          <div>
            <strong>{t("setup.title")}</strong>
            <small>{t("setup.subtitle")}</small>
          </div>
        </header>

        <div className="settingsBody">
          {(error || formError || textError) && (
            <pre className="modalError">{formError || textError || error}</pre>
          )}

          {mode === "form" ? (
            <>
              <div className="setupPresets">
                {opencodeContent && (
                  <button
                    className="presetButton presetHighlight"
                    type="button"
                    onClick={handleOpencodeImport}
                  >
                    <FolderOpen size={14} />
                    {t("setup.importFromOpencode")}
                  </button>
                )}
                <button
                  className="presetButton"
                  type="button"
                  onClick={() => setMode("text")}
                >
                  <FileCode2 size={14} />
                  {t("setup.manualImport")}
                </button>
              </div>

              <div className="setupPresets">
                {SETUP_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    className="presetButton"
                    type="button"
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="settingsGrid">
                <label>
                  <span>{t("setup.providerName")}</span>
                  <input
                    value={providerName}
                    onChange={(e) => setProviderName(e.target.value)}
                    placeholder={t("setup.providerNamePlaceholder")}
                  />
                </label>
                <label>
                  <span>{t("setup.modelId")}</span>
                  <input
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder={t("setup.modelIdPlaceholder")}
                  />
                </label>
                <label className="settingsWide">
                  <span>{t("setup.baseUrl")}</span>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={t("setup.baseUrlPlaceholder")}
                  />
                </label>
                <label className="settingsWide">
                  <span>{t("setup.apiKey")}</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t("setup.apiKeyPlaceholder")}
                  />
                </label>
                <label className="settingsWide">
                  <span>{t("setup.modelDisplayName")}</span>
                  <input
                    value={modelDisplayName}
                    onChange={(e) => setModelDisplayName(e.target.value)}
                    placeholder={t("setup.modelDisplayNamePlaceholder")}
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <button
                className="presetButton"
                type="button"
                onClick={() => setMode("form")}
              >
                <ChevronLeft size={14} />
                {t("setup.backToForm")}
              </button>
              <textarea
                className="settingsJsonEditor setupTextEditor"
                value={textImport}
                onChange={(e) => setTextImport(e.target.value)}
                placeholder={t("setup.manualImportPlaceholder")}
                spellCheck={false}
              />
            </>
          )}
        </div>

        <footer className="modalFooter">
          {mode === "form" ? (
            <button
              className="commandButton modalSaveButton"
              disabled={isSaving}
              onClick={handleGenerate}
            >
              {isSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
              {t("setup.generate")}
            </button>
          ) : (
            <button
              className="commandButton modalSaveButton"
              disabled={isSaving}
              onClick={handleTextImport}
            >
              {isSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
              {t("setup.generate")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
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

function orderSessionsByParent(sessions: SessionRecord[]) {
  const children = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  for (const session of sessions) {
    if (session.parentSessionId) {
      const list = children.get(session.parentSessionId) ?? [];
      list.push(session);
      children.set(session.parentSessionId, list);
    } else {
      roots.push(session);
    }
  }

  const ordered: SessionRecord[] = [];
  const push = (session: SessionRecord) => {
    ordered.push(session);
    for (const child of children.get(session.id) ?? []) {
      push(child);
    }
  };
  for (const root of roots) {
    push(root);
  }
  for (const session of sessions) {
    if (!ordered.some((item) => item.id === session.id)) {
      ordered.push(session);
    }
  }
  return ordered;
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
    return appT("attachment.uploadUnsupported");
  }
  const labels = kinds.map((kind) =>
    kind === "image" ? appT("common.image") : appT("attachment.textFile")
  );
  const separator = i18n.language === "zh" ? "、" : ", ";
  return appT("attachment.uploadTypes", { types: labels.join(separator) });
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
