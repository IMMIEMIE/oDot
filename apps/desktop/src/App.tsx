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
  FileText,
  FolderOpen,
  History,
  KeyRound,
  Loader2,
  Maximize2,
  MessageSquare,
  Minus,
  Network,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Terminal,
  Trash2,
  Upload,
  Wrench,
  X
} from "lucide-react";
import { OdodBotIcon } from "./OdodBotIcon";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
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
  deleteMcpServer,
  deleteQueuedInput,
  deleteSession,
  deleteSkill,
  fetchProjectFiles,
  findOpencodeConfig,
  getModelReasoningEfforts,
  getSessionEvents,
  importSkill,
  tailSessionEvents,
  listProjectCapabilities,
  listSessions,
  loadShellPolicy,
  loadProviderConfig,
  persistPlanFile,
  pickProviderConfigFile,
  pickProjectDirectory,
  pickSkillFile,
  promoteTask,
  revealProjectPath,
  rejectToolCall,
  replyPermission,
  recoverBackgroundTask,
  recoverSessionFromCheckpoint,
  rollbackSnapshot,
  saveMcpServer,
  saveProviderConfig,
  saveShellPolicy,
  promptSession,
  testMcpConnection,
  updateSessionMode,
  updateSessionTitle,
  type AgentMode,
  type BackgroundJobRecord,
  type EventRecord,
  type ExternalProjectSessionsPayload,
  type ExternalPromptReferencePayload,
  type LoadedSkill,
  type McpConfigFileResponse,
  type McpServerConfig,
  type McpToolDefinition,
  type PermissionRequestRecord,
  type PermissionReply,
  type ProjectFile,
  type ProjectCapabilities,
  type ProviderConfigFileResponse,
  type ProviderRecord,
  type ReasoningEffort,
  type SessionEventsResponse,
  type SessionInputRecord,
  type SessionRecord,
  type ShellPolicy,
  type SkillRecord,
  type ShellMode,
  type SnapshotRecord,
  type TodoRecord
} from "./api";
import {
  appendPromptReferenceSections,
  externalPromptReferenceKind,
  externalPromptReferenceLineLabel,
  externalPromptReferenceName,
  externalPromptReferencesFromPayload,
  formatExternalPromptReferences,
  mergeExternalPromptReferences,
  mergePromptReferencesForStorage,
  PROMPT_REFERENCES_STORAGE_KEY,
  readPromptReferences,
  referencesEqual,
  resolvePromptReferencesFromStorage,
  savePromptReferences,
  type ExternalPromptReference
} from "./externalPromptReferences";
import {
  clearExternalProjectSessions,
  EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY,
  readExternalProjectSessions,
  saveExternalProjectSessions
} from "./externalProjectSessions";
import {
  extractPromptEditorText,
  insertTextAtSelection,
  moveCaretToEnd,
  setPromptEditorText,
  syncPromptInlineReferences,
  type PromptInlineReference
} from "./promptInlineReferences";
import {
  EMPTY_SESSION_EVENTS as EMPTY_EVENTS,
  currentSessionEvents,
  mergeSessionEvents,
  type ODotRealtimeEvent,
  useSessionEventStore
} from "./sessionStore";
import {
  deriveFloatAgentStatus,
  loadFloatAgentStatus,
  persistFloatAgentStatus
} from "./floatAgentStatus";
import {
  clearPromptDraft,
  PROMPT_DRAFT_STORAGE_KEY,
  readPromptDraft,
  savePromptDraft
} from "./promptDraft";
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

const PROJECT_ROOT_STORAGE_KEY = "odot.projectRoot";
const LAST_SESSION_STORAGE_KEY = "odot.lastSessionId";

type TreeNode = {
  type: "dir" | "file";
  name: string;
  path: string;
  file?: ProjectFile;
  children: TreeNode[];
};

// Returns a callback with a stable identity that always invokes the latest version
// of `callback`. Lets us pass handlers into memoized children without recreating
// them every render (which would defeat `memo`) and without the stale-closure risk
// of hand-writing `useCallback` dependency lists for large handlers.
function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const ref = useRef(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}

// Memoized timeline leaf components. Each `App` re-render (one per streamed token)
// would otherwise re-render every timeline item and re-parse all of its markdown;
// wrapping them in `memo` (with stable callbacks from `useCallback`) lets only the
// items whose props actually changed re-render. The `*Impl` functions are hoisted,
// so referencing them here is safe.
const ConversationTimeline = memo(ConversationTimelineImpl);
const TimelineItemView = memo(TimelineItemViewImpl);
const CodeChangeCard = memo(CodeChangeCardImpl);
const CodeChangeSummaryCard = memo(CodeChangeSummaryCardImpl);
const McpToolCard = memo(McpToolCardImpl);
const MarkdownText = memo(MarkdownTextImpl);

export function App() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [configContent, setConfigContent] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [projectRoot, setProjectRoot] = useState(
    () => localStorage.getItem(PROJECT_ROOT_STORAGE_KEY) ?? ""
  );
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
  const [prompt, setPrompt] = useState(() => readPromptDraft()?.text ?? "");
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
  const promptInputRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const shellModeMenuRef = useRef<HTMLDivElement | null>(null);
  const realtimeTailTimerRef = useRef<number | undefined>(undefined);
  const composerReasoningLoadSeq = useRef(0);
  const composerReasoningSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerReasoningSaveInFlight = useRef(false);
  const pendingComposerReasoningSave = useRef<string | null>(null);
  const activeRunIdRef = useRef(0);
  const stopBaselineSeqRef = useRef(0);
  const rollbackInFlightRef = useRef(false);
  const promptDraftHydratedRef = useRef(false);
  const promptDraftUpdatedAtRef = useRef(readPromptDraft()?.updatedAt ?? 0);
  const autoCreatingExternalProjectRootRef = useRef<string | null>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isShellModeMenuOpen, setIsShellModeMenuOpen] = useState(false);
  const [composerReasoningEfforts, setComposerReasoningEfforts] = useState<ReasoningEffort[]>([]);
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ReasoningEffortSetting>("");
  const [isComposerReasoningLoading, setIsComposerReasoningLoading] = useState(false);
  const [isComposerReasoningSaving, setIsComposerReasoningSaving] = useState(false);
  const [promptAttachments, setPromptAttachments] = useState<PromptAttachment[]>([]);
  const [externalPromptReferences, setExternalPromptReferences] = useState<
    ExternalPromptReference[]
  >(() => readPromptReferences()?.references ?? []);
  const promptReferencesDraftUpdatedAtRef = useRef(
    readPromptReferences()?.updatedAt ?? 0
  );
  const [externalProjectSessions, setExternalProjectSessions] =
    useState<ExternalProjectSessionsPayload | null>(
      () => readExternalProjectSessions()?.payload ?? null
    );
  const externalProjectSessionsUpdatedAtRef = useRef(
    readExternalProjectSessions()?.updatedAt ?? 0
  );
  const [projectCapabilities, setProjectCapabilities] =
    useState<ProjectCapabilities | null>(null);
  const [loadedSkills, setLoadedSkills] = useState<LoadedSkill[]>([]);
  const [skillMenu, setSkillMenu] = useState<{
    open: boolean;
    query: string;
    start: number;
    end: number;
    activeIndex: number;
  }>({ open: false, query: "", start: 0, end: 0, activeIndex: 0 });
  const [leftWidth, setLeftWidth] = useState(() => {
    const stored = Number(localStorage.getItem("odot.leftWidth"));
    return Number.isFinite(stored) && stored >= 300 ? stored : 420;
  });
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(true);
  const [isPlanDockDismissed, setIsPlanDockDismissed] = useState(false);

  // Stable-identity handlers for the memoized timeline (see `useStableCallback`).
  const stableExecutePlan = useStableCallback((event: EventRecord) =>
    handleExecutePlan(event)
  );
  const stableRecoverAgent = useStableCallback((actionId: string) =>
    handleRecoverAgent(actionId)
  );
  const stableRollbackSnapshot = useStableCallback(
    (snapshotId: string) => void handleRollback(snapshotId)
  );
  const stableRollbackSnapshots = useStableCallback(
    (snapshotIds: string[], successText?: string) =>
      void handleRollbackMany(
        snapshotIds,
        successText ?? t("notice.rolledBackBeforePrompt")
      )
  );

  useEffect(() => {
    void bootstrap();
    return () => {
      if (realtimeTailTimerRef.current) {
        window.clearTimeout(realtimeTailTimerRef.current);
      }
      if (composerReasoningSaveTimer.current) {
        clearTimeout(composerReasoningSaveTimer.current);
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
    if (projectRoot.trim()) {
      localStorage.setItem(PROJECT_ROOT_STORAGE_KEY, projectRoot);
    } else {
      localStorage.removeItem(PROJECT_ROOT_STORAGE_KEY);
    }
  }, [projectRoot]);

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
        payload.kind === "task.failed" ||
        payload.kind === "background.job.started" ||
        payload.kind === "background.job.updated"
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
  const composerReasoningSliderOptions = useMemo<ReasoningEffortSetting[]>(
    () => ["", ...composerReasoningEfforts],
    [composerReasoningEfforts]
  );
  const composerReasoningSelectedValue: ReasoningEffortSetting =
    composerReasoningEffort && composerReasoningSliderOptions.includes(composerReasoningEffort)
      ? composerReasoningEffort
      : "";
  const composerReasoningSelectedIndex = Math.max(
    0,
    composerReasoningSliderOptions.indexOf(composerReasoningSelectedValue)
  );
  const allowedAttachmentKinds = useMemo(
    () => attachmentKindsFromConfig(configContent, selectedProviderId),
    [configContent, selectedProviderId]
  );
  const attachmentAccept = useMemo(
    () => attachmentAcceptValue(allowedAttachmentKinds),
    [allowedAttachmentKinds]
  );
  const canUploadAttachments = allowedAttachmentKinds.length > 0;
  const promptInlineReferences = useMemo(
    () => buildPromptInlineReferences(selectedPaths, promptAttachments, externalPromptReferences),
    [externalPromptReferences, promptAttachments, selectedPaths]
  );
  const skillOptions = useMemo(() => {
    const query = skillMenu.query.trim().toLowerCase();
    const skills = projectCapabilities?.skills ?? [];
    const selected = new Set(loadedSkills.map((skill) => skill.path));
    return skills
      .filter((skill) => !selected.has(skill.path))
      .filter((skill) => {
        if (!query) {
          return true;
        }
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          skill.path.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [loadedSkills, projectCapabilities?.skills, skillMenu.query]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  function handleWindowMinimize(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().minimize();
  }

  function handleWindowToggleMaximize(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().toggleMaximize();
  }

  function handleWindowClose(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().close();
  }

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
  const activeChildSessions = useMemo(
    () => selectedChildSessions.filter((session) => session.status === "active"),
    [selectedChildSessions]
  );
  const backgroundTaskSessionIds = useMemo(
    () =>
      new Set(
        eventsResponse.jobs
          .filter((job) => job.command.startsWith("task:") && job.status === "running")
          .map((job) => job.command.slice("task:".length))
      ),
    [eventsResponse.jobs]
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

  useEffect(() => {
    let disposed = false;
    if (!projectRoot) {
      setProjectCapabilities(null);
      return;
    }
    void refreshProjectCapabilities(projectRoot, configPath || selectedConfigPathForProject(projectRoot))
      .then((capabilities) => {
        if (!disposed && capabilities) {
          setProjectCapabilities(capabilities);
        }
      })
      .catch(() => {
        if (!disposed) {
          setProjectCapabilities(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [configPath, projectRoot]);

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
  const visibleQueuedInputs = useMemo(
    () => eventsResponse.inputs.filter((input) => input.status === "pending"),
    [eventsResponse.inputs]
  );
  const activityPause = useMemo(
    () => latestActivityPause(eventsResponse.events),
    [eventsResponse.events]
  );
  const visiblePermissions = useMemo(
    () => visiblePermissionRequests(eventsResponse.permissions),
    [eventsResponse.permissions]
  );

  // Auto-expand right pane when agent needs user approval
  useEffect(() => {
    if (
      isRightPaneCollapsed &&
      (pendingToolEvents.length > 0 ||
        visiblePermissions.length > 0 ||
        visibleJobs.length > 0 ||
        visibleQueuedInputs.length > 0 ||
        activityPause)
    ) {
      setIsRightPaneCollapsed(false);
    }
  }, [
    activityPause,
    pendingToolEvents,
    visiblePermissions,
    visibleJobs.length,
    visibleQueuedInputs.length,
    isRightPaneCollapsed,
  ]);

  const contextUsageFromEventsMemo = useMemo(
    () => contextUsageFromEvents(eventsResponse),
    [eventsResponse]
  );
  const contextEstimateBase = useMemo(
    () =>
      estimateContextBase({
        eventsResponse,
        configContent,
        selectedProviderId
      }),
    [configContent, eventsResponse, selectedProviderId]
  );
  const contextUsage = useMemo(
    () =>
      contextUsageFromEventsMemo ??
      estimateContextUsage(contextEstimateBase, prompt),
    [contextEstimateBase, contextUsageFromEventsMemo, prompt]
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
            extractExecutablePlanText(valueAsString(event.data.text)) !== null
        ) ?? null
    );
  }, [eventsResponse.events, selectedSession?.mode]);
  const planExecutionEvents = useMemo(
    () => latestPlanExecutionEvents(eventsResponse.events),
    [eventsResponse.events]
  );
  const planArtifact = useMemo(
    () => buildPlanArtifact(eventsResponse.events, eventsResponse.snapshots),
    [eventsResponse.events, eventsResponse.snapshots]
  );

  const planRightPaneRef = useRef(isRightPaneCollapsed);
  // Keep the "latest value" ref in sync via a layout effect (runs before the plan
  // effect below reads it) instead of mutating it during render.
  useLayoutEffect(() => {
    planRightPaneRef.current = isRightPaneCollapsed;
  });

  useEffect(() => {
    if (planExecutionEvents.length > 0 || eventsResponse.todos.length > 0 || planArtifact) {
      setIsPlanDockDismissed(false);
      if (planRightPaneRef.current) {
        setIsRightPaneCollapsed(false);
      }
    }
  }, [
    eventsResponse.todos.length,
    planArtifact,
    planExecutionEvents.length
  ]);

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

  useLayoutEffect(() => {
    if (promptDraftHydratedRef.current) {
      return;
    }
    promptDraftHydratedRef.current = true;
    if (!prompt.trim()) {
      return;
    }
    setPromptEditorText(promptInputRef.current, prompt, promptInlineReferences);
  }, [prompt, promptInlineReferences]);

  useEffect(() => {
    const applyExternalDraft = () => {
      const draft = readPromptDraft();
      if (!draft || draft.source === "main" || draft.updatedAt <= promptDraftUpdatedAtRef.current) {
        return;
      }
      promptDraftUpdatedAtRef.current = draft.updatedAt;
      setPrompt(draft.text);
      setPromptEditorText(promptInputRef.current, draft.text, promptInlineReferences);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROMPT_DRAFT_STORAGE_KEY) {
        applyExternalDraft();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", applyExternalDraft);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", applyExternalDraft);
    };
  }, [promptInlineReferences]);

  useEffect(() => {
    savePromptReferences(
      mergePromptReferencesForStorage(externalPromptReferences, selectedPaths, projectRoot),
      "main"
    );
    promptReferencesDraftUpdatedAtRef.current = readPromptReferences()?.updatedAt ?? Date.now();
  }, [externalPromptReferences, projectRoot, selectedPaths]);

  useEffect(() => {
    const applyExternalReferences = () => {
      setExternalPromptReferences((current) => {
        const nextReferences = resolvePromptReferencesFromStorage(
          "main",
          promptReferencesDraftUpdatedAtRef,
          current
        );
        return referencesEqual(current, nextReferences) ? current : nextReferences;
      });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROMPT_REFERENCES_STORAGE_KEY) {
        applyExternalReferences();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", applyExternalReferences);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", applyExternalReferences);
    };
  }, []);

  useLayoutEffect(() => {
    const editor = promptInputRef.current;
    if (!editor) {
      return;
    }
    syncPromptInlineReferences(editor, promptInlineReferences);
    setPrompt(extractPromptEditorText(editor));
  }, [promptInlineReferences]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExternalPromptReferencePayload>(
      "odot:external-prompt-references",
      async ({ payload }) => {
        if (disposed) {
          return;
        }
        const isVisible = await getCurrentWindow().isVisible().catch(() => true);
        if (disposed || !isVisible) {
          return;
        }
        if (isPromptLocked) {
          setNotice({ tone: "error", text: t("prompt.agentWorking") });
          return;
        }
        const nextReferences = externalPromptReferencesFromPayload(payload);
        if (!nextReferences.length) {
          setNotice({ tone: "error", text: t("error.unknown") });
          return;
        }
        setExternalPromptReferences((current) =>
          mergeExternalPromptReferences(current, nextReferences)
        );
        setNotice({
          tone: "success",
          text: t("notice.attachmentsAdded", { count: nextReferences.length })
        });
        promptInputRef.current?.focus();
      }
    ).then((dispose) => {
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
  }, [isPromptLocked, t]);

  useEffect(() => {
    const applyExternalProjectSessions = () => {
      const draft = readExternalProjectSessions();
      if (
        !draft ||
        draft.source === "main" ||
        draft.updatedAt <= externalProjectSessionsUpdatedAtRef.current
      ) {
        return;
      }
      externalProjectSessionsUpdatedAtRef.current = draft.updatedAt;
      setExternalProjectSessions(
        draft.payload.sessions.length || draft.payload.workspaceRoot
          ? draft.payload
          : null
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY) {
        applyExternalProjectSessions();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", applyExternalProjectSessions);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", applyExternalProjectSessions);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExternalProjectSessionsPayload>(
      "odot:external-project-sessions",
      ({ payload }) => {
        if (disposed) {
          return;
        }
        setExternalProjectSessions(
          payload.sessions.length || payload.workspaceRoot ? payload : null
        );
        saveExternalProjectSessions(payload, "main");
        externalProjectSessionsUpdatedAtRef.current =
          readExternalProjectSessions()?.updatedAt ?? Date.now();
        if (!payload.sessions.length && payload.workspaceRoot?.trim()) {
          void autoCreateExternalProjectSession(payload.workspaceRoot);
        }
      }
    ).then((dispose) => {
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
  }, [mode, shellMode]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ sessionId: string }>("odot:float-select-session", async ({ payload }) => {
      if (disposed) {
        return;
      }
      const nextSessions = sessions.length ? sessions : await refreshSessions();
      const session = nextSessions.find((item) => item.id === payload.sessionId);
      if (session) {
        await selectSession(session).catch(reportError);
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
  }, [sessions]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ workspaceRoot: string }>("odot:float-create-session", async ({ payload }) => {
      if (disposed) {
        return;
      }
      await createExternalProjectSession(payload.workspaceRoot).catch(reportError);
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
  }, [mode, shellMode]);

  useEffect(() => {
    persistFloatAgentStatus(loadFloatAgentStatus(), floatAgentStatus);
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
      const rememberedConfigPath = selectedConfigPathForProject(projectRoot);
      const configResult = await loadProviderConfig(projectRoot, rememberedConfigPath).catch((configError: unknown) => {
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
      const lastSessionId = localStorage.getItem(LAST_SESSION_STORAGE_KEY) ?? "";
      const restorableSession =
        nextSessions.find((session) => session.id === lastSessionId) ??
        nextSessions.find((session) =>
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

  async function saveSettings(
    content: string,
    policy: ShellPolicy,
    targetConfigPath?: string | null,
    options: { keepOpen?: boolean; silent?: boolean } = {}
  ) {
    setIsSavingConfig(true);
    try {
      const [config, savedPolicy] = await Promise.all([
        saveProviderConfig(content, projectRoot, targetConfigPath),
        saveShellPolicy(policy)
      ]);
      rememberConfigPathForProject(projectRoot, config.path);
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
      if (!options.keepOpen) {
        setIsSettingsOpen(false);
      }
      if (!options.silent) {
        setNotice({ tone: "success", text: t("notice.settingsSaved") });
      }
    } catch (error) {
      if (!options.silent) {
        reportError(error);
      }
      throw error;
    } finally {
      setIsSavingConfig(false);
    }
  }

  async function loadSettingsConfigFile(path: string) {
    const config = await loadProviderConfig(projectRoot, path);
    rememberConfigPathForProject(projectRoot, config.path);
    setConfigPath(config.path);
    setConfigContent(config.content);
    setProviders(config.providers);
    const preferredProviderId = preferredConfigProviderId(config);
    if (preferredProviderId) {
      setSelectedProviderId(preferredProviderId);
    }
    await refreshProjectCapabilities(projectRoot, config.path);
    return config;
  }

  async function refreshProjectCapabilities(
    root = projectRoot,
    targetConfigPath: string | null | undefined = configPath || selectedConfigPathForProject(root)
  ) {
    if (!root.trim()) {
      setProjectCapabilities(null);
      return null;
    }
    const capabilities = await listProjectCapabilities(root, targetConfigPath || null);
    setProjectCapabilities(capabilities);
    if (capabilities.configPath.trim() && root.trim() === projectRoot.trim()) {
      setConfigPath(capabilities.configPath);
      rememberConfigPathForProject(root, capabilities.configPath);
    }
    return capabilities;
  }

  function syncMcpConfigContent(response: McpConfigFileResponse) {
    setConfigContent(response.content);
    setProjectCapabilities((current) =>
      current
        ? {
            ...current,
            configPath: response.path,
            mcpServers: response.mcpServers
          }
        : current
    );
    if (response.path.trim()) {
      setConfigPath(response.path);
      rememberConfigPathForProject(projectRoot, response.path);
    }
  }

  async function handleSetupComplete(content: string) {
    setIsSetupSaving(true);
    try {
      const config = await saveProviderConfig(content, projectRoot, configPath || selectedConfigPathForProject(projectRoot));
      rememberConfigPathForProject(projectRoot, config.path);
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
    const sessionConfigPath =
      session.configPath ||
      selectedConfigPathForProject(session.projectRoot) ||
      (session.projectRoot === projectRoot ? configPath : null);
    const config = await loadProviderConfig(
      session.projectRoot,
      sessionConfigPath
    );
    setConfigPath(config.path);
    rememberConfigPathForProject(session.projectRoot, config.path);
    setConfigContent(config.content);
    setProviders(config.providers);

    setSelectedSessionId(session.id);
    rememberLastSessionId(session.id);
    setProjectRoot(session.projectRoot);
    setMode(session.mode);
    setShellMode(session.shellMode);
    setLoadedSkills([]);
    const sessionProviderExists = config.providers.some(
      (provider) => provider.id === session.providerId
    );
    setSelectedProviderId(
      sessionProviderExists ? session.providerId : preferredConfigProviderId(config)
    );
    await Promise.all([
      loadEvents(session.id),
      loadFiles(session.projectRoot),
      refreshProjectCapabilities(session.projectRoot, config.path)
    ]);
    if (!sessionProviderExists) {
      setNotice({ tone: "error", text: t("notice.sessionProviderMissing") });
    }
  }

  async function selectExternalProjectSession(sessionId: string) {
    const nextSessions = sessions.length ? sessions : await refreshSessions();
    const session = nextSessions.find((item) => item.id === sessionId);
    if (!session) {
      setNotice({ tone: "error", text: t("externalProjectSessions.notFound") });
      return;
    }
    await selectSession(session);
    setExternalProjectSessions(null);
    clearExternalProjectSessions("main");
    externalProjectSessionsUpdatedAtRef.current =
      readExternalProjectSessions()?.updatedAt ?? Date.now();
    setNotice({ tone: "success", text: t("externalProjectSessions.selected") });
  }

  async function createExternalProjectSession(workspaceRoot: string) {
    const root = workspaceRoot.trim();
    if (!root) {
      return;
    }
    await createSessionForProjectRoot(root);
    setExternalProjectSessions(null);
    clearExternalProjectSessions("main");
    externalProjectSessionsUpdatedAtRef.current =
      readExternalProjectSessions()?.updatedAt ?? Date.now();
  }

  async function autoCreateExternalProjectSession(workspaceRoot: string) {
    const key = normalizeProjectRootKey(workspaceRoot);
    if (!key || autoCreatingExternalProjectRootRef.current === key) {
      return;
    }
    autoCreatingExternalProjectRootRef.current = key;
    try {
      await createExternalProjectSession(workspaceRoot);
    } catch (error) {
      reportError(error);
    } finally {
      if (autoCreatingExternalProjectRootRef.current === key) {
        autoCreatingExternalProjectRootRef.current = null;
      }
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
      const config = await loadProviderConfig(selected, selectedConfigPathForProject(selected));
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

  async function createCurrentSessionInDirectory() {
    const selected = await pickProjectDirectory();
    if (!selected) {
      return undefined;
    }
    return createSessionForProjectRoot(selected);
  }

  async function createSessionForProjectRoot(root: string) {
    const targetRoot = root.trim();
    if (!targetRoot) {
      throw new Error(t("error.selectProject"));
    }
    setIsCreatingSession(true);
    try {
      const config = await loadProviderConfig(
        targetRoot,
        selectedConfigPathForProject(targetRoot)
      );
      const providerId = preferredConfigProviderId(config);
      if (!providerId) {
        throw new Error(t("error.providerMissing"));
      }
      setProjectRoot(targetRoot);
      setSelectedSessionId("");
      setEventsResponse(EMPTY_EVENTS);
      setConfigPath(config.path);
      rememberConfigPathForProject(targetRoot, config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
      setSelectedProviderId(providerId);
      await loadFiles(targetRoot);
      const session = await createSession({
        projectRoot: targetRoot,
        mode,
        providerId,
        shellMode,
        configPath: config.path || selectedConfigPathForProject(targetRoot) || null
      });
      await refreshSessions();
      setSelectedSessionId(session.id);
      rememberLastSessionId(session.id);
      setNotice({ tone: "success", text: t("notice.sessionCreated") });
      setEventsResponse(EMPTY_EVENTS);
      await refreshProjectCapabilities(targetRoot, config.path);
      return session;
    } catch (error) {
      reportError(error);
      throw error;
    } finally {
      setIsCreatingSession(false);
    }
  }

  async function createCurrentSession(root = projectRoot, targetConfigPath = configPath) {
    setIsCreatingSession(true);
    try {
      const session = await createSession({
        projectRoot: root,
        mode,
        providerId: selectedProviderId,
      shellMode,
      configPath: targetConfigPath || selectedConfigPathForProject(root) || null
    });
      await refreshSessions();
      setSelectedSessionId(session.id);
      rememberLastSessionId(session.id);
      setNotice({ tone: "success", text: t("notice.sessionCreated") });
      setEventsResponse(EMPTY_EVENTS);
      await refreshProjectCapabilities(root, targetConfigPath || selectedConfigPathForProject(root));
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

  function handlePromptPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    if (isPromptLocked) {
      return;
    }
    const files = clipboardFiles(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      void addPromptAttachments(files);
      return;
    }

    const text = event.clipboardData.getData("text/plain");
    if (!text) {
      return;
    }
    event.preventDefault();
    insertTextAtSelection(text);
    const editor = promptInputRef.current;
    if (editor) {
      const value = extractPromptEditorText(editor);
      setPrompt(value);
      savePromptDraft(value, "main");
      promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    }
  }

  function removePromptAttachment(id: string) {
    setPromptAttachments((current) =>
      current.filter((attachment) => attachment.id !== id)
    );
  }

  function removeExternalPromptReference(id: string) {
    setExternalPromptReferences((current) =>
      current.filter((reference) => reference.id !== id)
    );
  }

  function handlePromptInput(event: FormEvent<HTMLDivElement>) {
    const value = extractPromptEditorText(event.currentTarget);
    setPrompt(value);
    savePromptDraft(value, "main");
    promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    syncSkillMenu(value, value.length);
    pruneMissingPromptInlineReferences(event.currentTarget);
  }

  function handlePromptEditorClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const removeButton = target.closest<HTMLButtonElement>("[data-remove-inline-reference]");
    if (!removeButton) {
      return;
    }
    event.preventDefault();
    const referenceId = removeButton.dataset.removeInlineReference;
    const reference = promptInlineReferences.find((item) => item.id === referenceId);
    if (!reference) {
      return;
    }
    if (reference.source === "attachment") {
      removePromptAttachment(reference.sourceId);
    } else if (reference.source === "externalReference") {
      removeExternalPromptReference(reference.sourceId);
    } else {
      toggleFile(reference.sourceId);
    }
  }

  function pruneMissingPromptInlineReferences(editor: HTMLDivElement) {
    const presentIds = new Set(
      Array.from(editor.querySelectorAll<HTMLElement>("[data-inline-reference-id]"))
        .map((node) => node.dataset.inlineReferenceId)
        .filter(Boolean)
    );
    for (const reference of promptInlineReferences) {
      if (presentIds.has(reference.id)) {
        continue;
      }
      if (reference.source === "attachment") {
        removePromptAttachment(reference.sourceId);
      } else if (reference.source === "externalReference") {
        removeExternalPromptReference(reference.sourceId);
      } else {
        toggleFile(reference.sourceId);
      }
    }
  }

  function syncSkillMenu(value: string, cursor: number) {
    const token = slashTokenAtCursor(value, cursor);
    if (!token) {
      setSkillMenu((current) => ({ ...current, open: false }));
      return;
    }
    setSkillMenu({
      open: true,
      query: token.query,
      start: token.start,
      end: token.end,
      activeIndex: 0
    });
  }

  function selectSkill(skill: SkillRecord) {
    setLoadedSkills((current) =>
      current.some((item) => item.path === skill.path)
        ? current
        : [...current, { name: skill.name, path: skill.path }]
    );
    const before = prompt.slice(0, skillMenu.start);
    const after = prompt.slice(skillMenu.end);
    const next = `${before}${after}`.replace(/[ \t]{2,}/g, " ");
    setPromptEditorText(promptInputRef.current, next, promptInlineReferences);
    const value = extractPromptEditorText(promptInputRef.current);
    setPrompt(value);
    savePromptDraft(value, "main");
    promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    setSkillMenu((current) => ({ ...current, open: false }));
    window.setTimeout(() => {
      promptInputRef.current?.focus();
      moveCaretToEnd(promptInputRef.current);
    }, 0);
  }

  function removeLoadedSkill(path: string) {
    setLoadedSkills((current) => current.filter((skill) => skill.path !== path));
  }

  function renderExternalProjectSessionPicker() {
    const workspaceRoot = externalProjectSessions?.workspaceRoot?.trim() ?? "";
    const sessions = externalProjectSessions?.sessions ?? [];
    if (!workspaceRoot && !sessions.length) {
      return null;
    }
    return (
      <div className="externalProjectSessionPicker">
        <div className="externalProjectSessionHeader">
          <span>
            <FolderOpen size={13} />
            {t("externalProjectSessions.title")}
          </span>
          <button
            type="button"
            className="externalProjectSessionDismiss"
            aria-label={t("externalProjectSessions.dismiss")}
            onClick={() => {
              setExternalProjectSessions(null);
              clearExternalProjectSessions("main");
              externalProjectSessionsUpdatedAtRef.current =
                readExternalProjectSessions()?.updatedAt ?? Date.now();
            }}
          >
            <X size={12} />
          </button>
        </div>
        <div className="externalProjectSessionList">
          {sessions.map((session) => {
            const isCurrent = session.id === selectedSessionId;
            return (
              <button
                type="button"
                key={session.id}
                className={`externalProjectSessionOption ${isCurrent ? "active" : ""}`}
                onClick={() => void selectExternalProjectSession(session.id)}
              >
                <span className="externalProjectSessionTitle">{session.title}</span>
                <span className="externalProjectSessionMeta">
                  {modeLabel(session.mode)} / {t(`shellMode.${session.shellMode}`)} / {session.status}
                </span>
                <small>{formatSessionUpdatedAt(session.updatedAt)}</small>
              </button>
            );
          })}
          {workspaceRoot && (
            <button
              type="button"
              className="externalProjectSessionOption externalProjectSessionOption--create"
              disabled={isCreatingSession}
              onClick={() => void createExternalProjectSession(workspaceRoot)}
            >
              <span className="externalProjectSessionTitle">
                <Plus size={13} />
                {t("externalProjectSessions.create")}
              </span>
              <span className="externalProjectSessionMeta">{workspaceRoot}</span>
              <small>
                {sessions.length
                  ? t("externalProjectSessions.createInstead")
                  : t("externalProjectSessions.autoCreating")}
              </small>
            </button>
          )}
        </div>
      </div>
    );
  }

  async function handleSubmitPrompt() {
    if (
      (!prompt.trim() &&
        !promptAttachments.length &&
        !externalPromptReferences.length &&
        !selectedPaths.size &&
        !loadedSkills.length) ||
      isPromptLocked
    ) {
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
      const externalReferenceText = formatExternalPromptReferences(externalPromptReferences);
      const editorPrompt = extractPromptEditorText(promptInputRef.current, {
        includeReferences: true
      }).trim();
      const promptText = editorPrompt || prompt.trim();
      const finalPrompt = appendPromptReferenceSections(
        promptText || t("prompt.continueFromAttachment"),
        [
          selectedFileText ? `${t("prompt.selectedFiles")}\n${selectedFileText}` : "",
          externalReferenceText
        ]
      );
      const response = await promptSession({
        sessionId: session.id,
        prompt: finalPrompt,
        attachments: promptAttachments.map(toPromptAttachmentInput),
        loadedSkills,
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
      clearPromptDraft("main");
      promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
      setPromptAttachments([]);
      setExternalPromptReferences([]);
      setPromptEditorText(
        promptInputRef.current,
        "",
        buildPromptInlineReferences(selectedPaths, [], [])
      );
      setLoadedSkills([]);
      setSkillMenu((current) => ({ ...current, open: false }));
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

    const planText = extractExecutablePlanText(valueAsString(planEvent.data.text));
    if (!planText) {
      setNotice({ tone: "error", text: t("notice.noPlanContent") });
      return;
    }

    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsSubmitting(true);
    setNotice({ tone: "info", text: t("notice.executingPlan") });
    try {
      const planPath = await persistPlanFile({
        sessionId: selectedSession.id,
        planText
      });
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
        prompt: buildPlanExecutionPrompt(planText, planPath),
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
        const nextSessions = await refreshSessions();
        const currentSession = nextSessions.find((session) => session.id === sessionId);
        if (currentSession) {
          setMode(currentSession.mode);
          setShellMode(currentSession.shellMode);
        }
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

  async function handleDeleteQueuedInput(inputId: string) {
    setIsMutating(true);
    try {
      const response = await deleteQueuedInput(inputId);
      setEventsResponse(response);
      setNotice({ tone: "success", text: t("notice.queueUpdated", { defaultValue: "Queue updated" }) });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleRecoverBackgroundTask(jobId: string, action: "resumeChild" | "abandon") {
    setIsMutating(true);
    try {
      const response = await recoverBackgroundTask({ jobId, action });
      setEventsResponse(response);
      await refreshSessions();
      setNotice({
        tone: action === "abandon" ? "info" : "success",
        text: t("notice.recoveryActionStarted", { defaultValue: "Recovery action started" })
      });
    } catch (error) {
      reportError(error);
    } finally {
      setIsMutating(false);
    }
  }

  async function handlePromoteTask(taskSessionId: string) {
    if (!selectedSessionId) {
      return;
    }
    setIsMutating(true);
    try {
      const response = await promoteTask({
        sessionId: selectedSessionId,
        taskSessionId
      });
      setEventsResponse((current) => mergeSessionEvents(current, response));
      setNotice({ tone: "success", text: t("notice.agentContinuing") });
    } catch (error) {
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

  async function loadComposerReasoningEfforts(providerRecordId = selectedProviderId) {
    const selected = splitProviderRecordId(providerRecordId);
    if (!selected.providerId || !selected.modelId) {
      setComposerReasoningEfforts([]);
      setComposerReasoningEffort("");
      return;
    }
    const seq = composerReasoningLoadSeq.current + 1;
    composerReasoningLoadSeq.current = seq;
    setIsComposerReasoningLoading(true);
    try {
      const result = await getModelReasoningEfforts(
        configContent,
        selected.providerId,
        selected.modelId
      );
      if (composerReasoningLoadSeq.current !== seq) {
        return;
      }
      setComposerReasoningEfforts(result.efforts);
      setComposerReasoningEffort(result.current ?? "");
    } catch (error) {
      if (composerReasoningLoadSeq.current === seq) {
        setComposerReasoningEfforts([]);
        setComposerReasoningEffort("");
        reportError(error);
      }
    } finally {
      if (composerReasoningLoadSeq.current === seq) {
        setIsComposerReasoningLoading(false);
      }
    }
  }

  function openComposerModelMenu() {
    setIsModelMenuOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        void loadComposerReasoningEfforts();
      }
      return nextOpen;
    });
  }

  function scheduleComposerReasoningSave(content: string) {
    pendingComposerReasoningSave.current = content;
    if (composerReasoningSaveTimer.current) {
      clearTimeout(composerReasoningSaveTimer.current);
    }
    composerReasoningSaveTimer.current = setTimeout(() => {
      composerReasoningSaveTimer.current = null;
      void flushComposerReasoningSave();
    }, 300);
  }

  async function flushComposerReasoningSave() {
    if (composerReasoningSaveInFlight.current) {
      return;
    }
    const content = pendingComposerReasoningSave.current;
    if (!content) {
      return;
    }
    pendingComposerReasoningSave.current = null;
    composerReasoningSaveInFlight.current = true;
    setIsComposerReasoningSaving(true);
    try {
      const config = await saveProviderConfig(content, projectRoot, configPath || null);
      rememberConfigPathForProject(projectRoot, config.path);
      setConfigPath(config.path);
      setConfigContent(config.content);
      setProviders(config.providers);
    } catch (error) {
      reportError(error);
    } finally {
      composerReasoningSaveInFlight.current = false;
      setIsComposerReasoningSaving(false);
      if (pendingComposerReasoningSave.current) {
        if (composerReasoningSaveTimer.current) {
          clearTimeout(composerReasoningSaveTimer.current);
        }
        composerReasoningSaveTimer.current = setTimeout(() => {
          composerReasoningSaveTimer.current = null;
          void flushComposerReasoningSave();
        }, 300);
      }
    }
  }

  function changeComposerReasoningEffort(nextEffort: ReasoningEffortSetting) {
    if (!selectedProviderId) {
      return;
    }
    setComposerReasoningEffort(nextEffort);
    composerReasoningLoadSeq.current += 1;
    try {
      const fields = parseProviderSettings(configContent, selectedProviderId);
      const nextContent = buildProviderConfigContent(configContent, {
        ...fields,
        reasoningEffort: nextEffort
      });
      setConfigContent(nextContent);
      scheduleComposerReasoningSave(nextContent);
    } catch (error) {
      reportError(error);
    }
  }

  function selectProviderForCurrentSession(providerId: string, keepModelMenuOpen = false) {
    setSelectedProviderId(providerId);
    setIsModelMenuOpen(keepModelMenuOpen);
    if (keepModelMenuOpen) {
      void loadComposerReasoningEfforts(providerId);
    }
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

  async function switchToFloatWindow() {
    const mainWin = getCurrentWindow();
    const floatWin = await WebviewWindow.getByLabel("float");
    if (!floatWin) {
      setNotice({ tone: "error", text: t("error.unknown") });
      return;
    }
    persistFloatAgentStatus(loadFloatAgentStatus(), floatAgentStatus);
    savePromptDraft(
      extractPromptEditorText(promptInputRef.current) || prompt,
      "main"
    );
    promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    savePromptReferences(
      mergePromptReferencesForStorage(externalPromptReferences, selectedPaths, projectRoot),
      "main"
    );
    promptReferencesDraftUpdatedAtRef.current = readPromptReferences()?.updatedAt ?? Date.now();
    try {
      await floatWin.show();
      await floatWin.setFocus();
      await mainWin.hide();
    } catch (error) {
      await mainWin.show().catch(() => undefined);
      await mainWin.setFocus().catch(() => undefined);
      reportError(error);
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
      clearLastSessionId(sessionId);
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
          disabled={isCreatingSession || isAgentWorking || !selectedProviderId}
          onClick={() =>
            void createCurrentSessionInDirectory()
              .then((session) => {
                if (session) {
                  setIsSessionsOpen(false);
                }
              })
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
      <div className="windowDragStrip" data-tauri-drag-region aria-hidden="true" />
      <aside className="leftPane">
        <header className="brandRow" onClick={() => void switchToFloatWindow()}>
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
              executablePlanEventId={latestExecutablePlanEvent?.id ?? ""}
              canExecutePlan={!isPromptLocked && !isMutating}
              onExecutePlan={stableExecutePlan}
              rollbackDisabled={isMutating}
              onRollbackSnapshot={stableRollbackSnapshot}
              onRollbackSnapshots={stableRollbackSnapshots}
              onRecoverAgent={stableRecoverAgent}
            />
            {!eventsResponse.events.length && (
              <div className="emptyTimeline">
                <BrainCircuit size={28} />
                <span>{t("empty.startPrompt")}</span>
              </div>
            )}
            <div ref={timelineEndRef} />
          </div>

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
              {renderExternalProjectSessionPicker()}
              <div className="promptInputRow">
                {loadedSkills.length > 0 && (
                  <div className="promptSkillTags">
                    {loadedSkills.map((skill) => (
                      <span className="promptSkillTag" key={skill.path}>
                        <BrainCircuit size={12} />
                        <span>{skill.name}</span>
                        <button
                          type="button"
                          aria-label={t("skills.removeLoaded", { name: skill.name })}
                          disabled={isPromptLocked}
                          onClick={() => removeLoadedSkill(skill.path)}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div
                  ref={promptInputRef}
                  className={`promptInput promptRichInput ${
                    !prompt.trim() && !promptInlineReferences.length ? "empty" : ""
                  }`}
                  role="textbox"
                  aria-multiline="true"
                  aria-disabled={isPromptLocked}
                  contentEditable={!isPromptLocked}
                  suppressContentEditableWarning
                  onInput={handlePromptInput}
                  onPaste={handlePromptPaste}
                  onClick={handlePromptEditorClick}
                  data-placeholder={
                    isAgentWorking
                      ? t("prompt.agentWorking")
                      : isStopping
                        ? t("prompt.agentStopping")
                        : pendingToolEvents.length
                          ? t("prompt.pendingCommands")
                          : t("prompt.followUp")
                  }
                  onKeyDown={(event) => {
                    if (skillMenu.open) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setSkillMenu((current) => ({
                          ...current,
                          activeIndex: skillOptions.length
                            ? (current.activeIndex + 1) % skillOptions.length
                            : 0
                        }));
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setSkillMenu((current) => ({
                          ...current,
                          activeIndex: skillOptions.length
                            ? (current.activeIndex - 1 + skillOptions.length) % skillOptions.length
                            : 0
                        }));
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setSkillMenu((current) => ({ ...current, open: false }));
                        return;
                      }
                      if (event.key === "Enter" && skillOptions[skillMenu.activeIndex]) {
                        event.preventDefault();
                        selectSkill(skillOptions[skillMenu.activeIndex]);
                        return;
                      }
                    }
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
              </div>
              {skillMenu.open && !isPromptLocked && (
                <div className="skillSlashOverlay">
                  <div className="skillSlashMenu" role="listbox" aria-label={t("skills.menuLabel")}>
                    {skillOptions.length ? (
                      skillOptions.map((skill, index) => (
                        <button
                          type="button"
                          key={skill.path}
                          className={`skillSlashOption ${index === skillMenu.activeIndex ? "active" : ""}`}
                          role="option"
                          aria-selected={index === skillMenu.activeIndex}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectSkill(skill)}
                        >
                          <BrainCircuit size={14} />
                          <span>{skill.name}</span>
                          <small>{skill.description || skill.path}</small>
                        </button>
                      ))
                    ) : (
                      <div className="skillSlashEmpty">{t("skills.empty")}</div>
                    )}
                  </div>
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
                      onClick={openComposerModelMenu}
                    >
                      <span>{selectedProvider ? selectedModelLabel : t("empty.noModelConfigured")}</span>
                      <ChevronDown size={15} />
                    </button>
                    {isModelMenuOpen && !isPromptLocked && (
                      <div className="composerModelMenu" role="listbox" aria-label={t("nav.selectModel")}>
                        <div className="composerModelList">
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
                                onClick={() => selectProviderForCurrentSession(provider.id, true)}
                              >
                                <span>{providerModelLabel(provider)}</span>
                                {isSelected && <Check size={15} />}
                              </button>
                            );
                          })}
                        </div>
                        <div className="composerReasoningPanel">
                          <div className="composerReasoningHeader">
                            <span>
                              <BrainCircuit size={14} />
                              {t("settings.reasoningEffort")}
                            </span>
                            <strong>
                              {reasoningEffortLabel(composerReasoningSelectedValue, t)}
                            </strong>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={Math.max(0, composerReasoningSliderOptions.length - 1)}
                            step={1}
                            value={composerReasoningSelectedIndex}
                            disabled={
                              isComposerReasoningLoading ||
                              composerReasoningSliderOptions.length <= 1
                            }
                            onChange={(event) => {
                              const nextIndex = Number(event.target.value);
                              changeComposerReasoningEffort(
                                composerReasoningSliderOptions[nextIndex] ?? ""
                              );
                            }}
                          />
                          <div
                            className="composerReasoningTicks"
                            style={{
                              gridTemplateColumns: `repeat(${composerReasoningSliderOptions.length}, minmax(0, 1fr))`
                            }}
                          >
                            {composerReasoningSliderOptions.map((item) => (
                              <span key={item || "auto"}>
                                {reasoningEffortLabel(item, t)}
                              </span>
                            ))}
                          </div>
                          {(isComposerReasoningLoading ||
                            isComposerReasoningSaving ||
                            composerReasoningEfforts.length === 0) && (
                            <small className="composerReasoningStatus">
                              {isComposerReasoningLoading
                                ? t("settings.reasoningLoading")
                                : isComposerReasoningSaving
                                  ? t("settings.reasoningSaving")
                                  : t("settings.reasoningUnavailable")}
                            </small>
                          )}
                        </div>
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
                        : (!prompt.trim() &&
                            !promptAttachments.length &&
                            !selectedPaths.size &&
                            !externalPromptReferences.length &&
                            !loadedSkills.length) ||
                          isPromptLocked ||
                          !selectedProviderId
                    }
                    onClick={() =>
                      isAgentWorking
                        ? void handleStopAgent()
                        : void handleSubmitPrompt()
                    }
                  >
                    {isAgentWorking ? <span className="stopIconSolid" aria-hidden="true" /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <div className="windowActionBar">
        <div
          className="windowControls"
          role="group"
          aria-label="Window actions"
        >
          <button
            className="windowControlButton"
            type="button"
            aria-label={isRightPaneCollapsed ? t("nav.expandRightPane") : t("nav.collapseRightPane")}
            title={isRightPaneCollapsed ? t("nav.expandRightPane") : t("nav.collapseRightPane")}
            onClick={() => setIsRightPaneCollapsed((current) => !current)}
          >
            {isRightPaneCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
          <button
            type="button"
            className="windowControlButton"
            aria-label="Minimize window"
            title="Minimize"
            onClick={handleWindowMinimize}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="windowControlButton"
            aria-label="Maximize window"
            title="Maximize"
            onClick={handleWindowToggleMaximize}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="windowControlButton danger"
            aria-label="Close window"
            title="Close"
            onClick={handleWindowClose}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <aside className={`rightPane ${isRightPaneCollapsed ? "collapsed" : ""}`}>

        {!isRightPaneCollapsed && (
          <>
            {!isPlanDockDismissed && (planExecutionEvents.length > 0 || eventsResponse.todos.length > 0 || planArtifact) && (
              <PlanExecutionDock
                events={planExecutionEvents}
                onDismiss={() => setIsPlanDockDismissed(true)}
                plan={planArtifact}
                sessionId={selectedSessionId}
                snapshots={eventsResponse.snapshots}
                todos={eventsResponse.todos}
              />
            )}

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
                    active: activeChildSessions.length
                  })}
                </small>
              )}
              {activeChildSessions.length > 0 && (
                <div className="stackList compact">
                  {activeChildSessions.map((session) => {
                    const isBackground = backgroundTaskSessionIds.has(session.id);
                    return (
                      <div className="approvalRow" key={session.id}>
                        <code>{session.title}</code>
                        <button
                          className="iconButton"
                          disabled={isMutating || isBackground}
                          onClick={() => void handlePromoteTask(session.id)}
                          title={t("nav.backgroundJobs")}
                        >
                          <Clock3 size={16} />
                        </button>
                      </div>
                    );
                  })}
                </div>
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

            {pendingToolEvents.length > 0 && (
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
                        {isShellPending(event) && (
                          <button
                            className="iconButton trust"
                            disabled={isMutating}
                            onClick={() => void handleApproveAndAllow(event)}
                            title={t("common.acceptAndAllowlist")}
                          >
                            <Save size={16} />
                          </button>
                        )}
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
                </div>
              </section>
            )}

            {visiblePermissions.length > 0 && (
              <section className="rightSection">
                <SectionTitle icon={<KeyRound size={16} />} title={t("nav.permissionRequests")} />
                <div className="stackList">
                  {visiblePermissions.map((request) => (
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
                </div>
              </section>
            )}

            {activityPause && (
              <section className="rightSection">
                <SectionTitle
                  icon={<AlertTriangle size={16} />}
                  title={t("nav.activityPaused", { defaultValue: "Activity paused" })}
                />
                <div className="activityPauseBox">
                  <strong>
                    {activityPause.event.type === "run.activity.limit_reached"
                      ? t("activity.limitReached", { defaultValue: "Step limit reached" })
                      : t("activity.earlyStop", { defaultValue: "Repeated action stopped" })}
                  </strong>
                  <span>{activityPauseDescription(activityPause.event)}</span>
                  <button
                    className="iconTextButton compact"
                    disabled={!selectedSessionId || isMutating || isPromptLocked}
                    onClick={() => void handleRecoverAgent("continue")}
                  >
                    <Play size={16} />
                    <span>{t("common.continue")}</span>
                  </button>
                </div>
              </section>
            )}

            {visibleQueuedInputs.length > 0 && (
              <section className="rightSection">
                <SectionTitle
                  icon={<MessageSquare size={16} />}
                  title={`${t("nav.queuedInputs", { defaultValue: "Queued inputs" })} (${visibleQueuedInputs.length})`}
                />
                <div className="stackList">
                  {visibleQueuedInputs.map((input) => (
                    <div className="approvalRow" key={input.id}>
                      <code>{formatQueuedInput(input)}</code>
                      <button
                        className="iconButton danger"
                        disabled={isMutating}
                        onClick={() => void handleDeleteQueuedInput(input.id)}
                        title={t("common.delete", { defaultValue: "Delete" })}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {visibleJobs.length > 0 && (
              <section className="rightSection">
                <SectionTitle icon={<Clock3 size={16} />} title={t("nav.backgroundJobs")} />
                <div className="stackList">
                  {visibleJobs.map((job) => (
                    <div className="approvalRow" key={job.id}>
                      <code>{formatBackgroundJob(job)}</code>
                      <div className="inlineActions">
                        {isRecoverableBackgroundJob(job) && (
                          <>
                            <button
                              className="iconButton success"
                              disabled={isMutating}
                              onClick={() => void handleRecoverBackgroundTask(job.id, "resumeChild")}
                              title={t("recovery.resumeChild", { defaultValue: "Resume child session" })}
                            >
                              <Play size={16} />
                            </button>
                            <button
                              className="iconButton ghost"
                              disabled={isMutating}
                              onClick={() => void handleRecoverBackgroundTask(job.id, "abandon")}
                              title={t("recovery.abandon", { defaultValue: "Abandon task" })}
                            >
                              <X size={16} />
                            </button>
                          </>
                        )}
                        <button
                          className="iconButton danger"
                          disabled={isMutating || job.status !== "running"}
                          onClick={() => void handleCancelJob(job.id)}
                          title={t("nav.stopJob")}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

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
          projectRoot={projectRoot}
          projectCapabilities={projectCapabilities}
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
          onLoadConfigFile={loadSettingsConfigFile}
          onRefreshCapabilities={(targetConfigPath) =>
            refreshProjectCapabilities(projectRoot, targetConfigPath || configPath || null)
          }
          onMcpConfigChanged={syncMcpConfigContent}
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
  projectRoot,
  projectCapabilities,
  providers,
  selectedProviderId,
  shellPolicy,
  themeMode,
  locale,
  isSaving,
  onThemeModeChange,
  onLocaleChange,
  onClose,
  onSave,
  onLoadConfigFile,
  onRefreshCapabilities,
  onMcpConfigChanged
}: {
  configPath: string;
  configContent: string;
  projectRoot: string;
  projectCapabilities: ProjectCapabilities | null;
  providers: ProviderRecord[];
  selectedProviderId: string;
  shellPolicy: ShellPolicy;
  themeMode: ThemeMode;
  locale: AppLocale;
  isSaving: boolean;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: AppLocale) => void;
  onClose: () => void;
  onSave: (
    content: string,
    policy: ShellPolicy,
    configPath?: string | null,
    options?: { keepOpen?: boolean; silent?: boolean }
  ) => Promise<void>;
  onLoadConfigFile: (configPath: string) => Promise<ProviderConfigFileResponse>;
  onRefreshCapabilities: (configPath?: string | null) => Promise<ProjectCapabilities | null>;
  onMcpConfigChanged: (response: McpConfigFileResponse) => void;
}) {
  const { t } = useTranslation();
  const initial = parseProviderSettings(configContent, selectedProviderId);
  const [providerId, setProviderId] = useState(initial.providerId);
  const [modelId, setModelId] = useState(initial.modelId);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSetting>(
    initial.reasoningEffort
  );
  const [reasoningEfforts, setReasoningEfforts] = useState<ReasoningEffort[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [isReasoningLoading, setIsReasoningLoading] = useState(false);
  const [isReasoningSaving, setIsReasoningSaving] = useState(false);
  const [name, setName] = useState(initial.name);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [supportsResponses, setSupportsResponses] = useState(initial.supportsResponses);
  const [responsesSource, setResponsesSource] = useState(initial.responsesSource);
  const [selectedConfigPath, setSelectedConfigPath] = useState(configPath);
  const [jsonText, setJsonText] = useState(configContent);
  const [allowlistText, setAllowlistText] = useState(
    shellPolicy.autoAllowlist.join("\n")
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"ai" | "mcp" | "skills">("ai");

  // MCP tab state
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(
    projectCapabilities?.mcpServers ?? []
  );
  const [mcpEditing, setMcpEditing] = useState<McpServerConfig | null>(null);
  const [mcpIsNew, setMcpIsNew] = useState(false);
  const [mcpFormId, setMcpFormId] = useState("");
  const [mcpFormCommand, setMcpFormCommand] = useState("");
  const [mcpFormArgs, setMcpFormArgs] = useState("");
  const [mcpFormEnvPairs, setMcpFormEnvPairs] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [mcpFormCwd, setMcpFormCwd] = useState("");
  const [mcpFormTimeout, setMcpFormTimeout] = useState(60);
  const [mcpFormRequireApproval, setMcpFormRequireApproval] = useState(true);
  const [mcpFormReadOnly, setMcpFormReadOnly] = useState(false);
  const [mcpFormEnabled, setMcpFormEnabled] = useState(true);
  const [mcpShowJsonImport, setMcpShowJsonImport] = useState(false);
  const [mcpJsonText, setMcpJsonText] = useState("");
  const [mcpTestResult, setMcpTestResult] = useState<{ ok: boolean; tools: McpToolDefinition[]; error?: string } | null>(null);
  const [mcpTesting, setMcpTesting] = useState(false);

  // Skill tab state
  const [skills, setSkills] = useState<SkillRecord[]>(projectCapabilities?.skills ?? []);
  const [skillExpanded, setSkillExpanded] = useState<string | null>(null);
  const [skillContents, setSkillContents] = useState<Record<string, string>>({});
  const reasoningLoadSeq = useRef(0);
  const reasoningSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasoningSaveInFlight = useRef(false);
  const pendingReasoningSave = useRef<{
    content: string;
    policy: ShellPolicy;
    configPath: string | null;
  } | null>(null);

  useEffect(() => {
    setMcpServers(projectCapabilities?.mcpServers ?? []);
    setSkills(projectCapabilities?.skills ?? []);
    setSkillExpanded((current) =>
      current && projectCapabilities?.skills.some((skill) => skill.path === current)
        ? current
        : null
    );
  }, [projectCapabilities]);

  useEffect(() => {
    return () => {
      if (reasoningSaveTimer.current) {
        clearTimeout(reasoningSaveTimer.current);
      }
    };
  }, []);

  const providerOptions = useMemo(
    () => providerChoices(jsonText, providers, providerId),
    [jsonText, providerId, providers]
  );
  const modelOptions = useMemo(
    () => modelChoices(jsonText, providerId, modelId),
    [jsonText, providerId, modelId]
  );

  function currentFields(
    overrides: Partial<ProviderSettingsFields> = {}
  ): ProviderSettingsFields {
    return {
      providerId,
      modelId,
      name,
      baseUrl,
      apiKey,
      supportsResponses,
      responsesSource,
      reasoningEffort,
      ...overrides
    };
  }

  function flushCurrentProviderDraft() {
    const next = buildProviderConfigContent(jsonText, currentFields());
    setJsonText(next);
    return next;
  }

  function currentPolicy(): ShellPolicy {
    return {
      autoAllowlist: allowlistText
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
    };
  }

  async function loadReasoningEfforts(
    content = jsonText,
    nextProviderId = providerId,
    nextModelId = modelId
  ) {
    if (!nextProviderId || !nextModelId) {
      setReasoningEfforts([]);
      return;
    }
    const seq = reasoningLoadSeq.current + 1;
    reasoningLoadSeq.current = seq;
    setIsReasoningLoading(true);
    try {
      const result = await getModelReasoningEfforts(content, nextProviderId, nextModelId);
      if (reasoningLoadSeq.current !== seq) {
        return;
      }
      setReasoningEfforts(result.efforts);
      setReasoningEffort(result.current ?? "");
    } catch (loadError) {
      if (reasoningLoadSeq.current === seq) {
        setReasoningEfforts([]);
        setError(errorMessage(loadError));
      }
    } finally {
      if (reasoningLoadSeq.current === seq) {
        setIsReasoningLoading(false);
      }
    }
  }

  function openModelPicker(nextOpen: boolean) {
    setModelPickerOpen(nextOpen);
    if (!nextOpen) {
      return;
    }
    setError("");
    try {
      const draft = flushCurrentProviderDraft();
      void loadReasoningEfforts(draft, providerId, modelId);
    } catch (openError) {
      setError(errorMessage(openError));
    }
  }

  function scheduleReasoningSave(content: string) {
    pendingReasoningSave.current = {
      content,
      policy: currentPolicy(),
      configPath: selectedConfigPath || null
    };
    if (reasoningSaveTimer.current) {
      clearTimeout(reasoningSaveTimer.current);
    }
    reasoningSaveTimer.current = setTimeout(() => {
      reasoningSaveTimer.current = null;
      void flushReasoningSave();
    }, 300);
  }

  async function flushReasoningSave() {
    if (reasoningSaveInFlight.current) {
      return;
    }
    const pending = pendingReasoningSave.current;
    if (!pending) {
      return;
    }
    pendingReasoningSave.current = null;
    reasoningSaveInFlight.current = true;
    setIsReasoningSaving(true);
    try {
      await onSave(pending.content, pending.policy, pending.configPath, {
        keepOpen: true,
        silent: true
      });
      setError("");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      reasoningSaveInFlight.current = false;
      setIsReasoningSaving(false);
      if (pendingReasoningSave.current) {
        if (reasoningSaveTimer.current) {
          clearTimeout(reasoningSaveTimer.current);
        }
        reasoningSaveTimer.current = setTimeout(() => {
          reasoningSaveTimer.current = null;
          void flushReasoningSave();
        }, 300);
      }
    }
  }

  function handleReasoningEffortChange(nextEffort: ReasoningEffortSetting) {
    setError("");
    setReasoningEffort(nextEffort);
    reasoningLoadSeq.current += 1;
    try {
      const nextContent = buildProviderConfigContent(
        jsonText,
        currentFields({ reasoningEffort: nextEffort })
      );
      setJsonText(nextContent);
      scheduleReasoningSave(nextContent);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  function syncFromSelection(nextProviderId: string, nextModelId?: string) {
    const nextText = flushCurrentProviderDraft();
    const parsed = parseProviderSettings(
      nextText,
      nextModelId ? `${nextProviderId}/${nextModelId}` : `${nextProviderId}/${modelId}`
    );
    setProviderId(parsed.providerId || nextProviderId);
    setModelId(parsed.modelId || nextModelId || "");
    setName(parsed.name);
    setBaseUrl(parsed.baseUrl);
    setApiKey(parsed.apiKey);
    setSupportsResponses(parsed.supportsResponses);
    setResponsesSource(parsed.responsesSource);
    setReasoningEffort(parsed.reasoningEffort);
    if (modelPickerOpen) {
      void loadReasoningEfforts(nextText, parsed.providerId || nextProviderId, parsed.modelId);
    }
  }

  async function handleSave() {
    setError("");
    try {
      const nextContent = flushCurrentProviderDraft();
      const nextPolicy = currentPolicy();
      await onSave(nextContent, nextPolicy, selectedConfigPath);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  function syncFromParsed(content: string, selection: string) {
    const parsed = parseProviderSettings(content, selection);
    setProviderId(parsed.providerId);
    setModelId(parsed.modelId);
    setName(parsed.name);
    setBaseUrl(parsed.baseUrl);
    setApiKey(parsed.apiKey);
    setSupportsResponses(parsed.supportsResponses);
    setResponsesSource(parsed.responsesSource);
    setReasoningEffort(parsed.reasoningEffort);
  }

  function handleAddProvider() {
    setError("");
    try {
      const draft = flushCurrentProviderDraft();
      const config = JSON.parse(draft) as Record<string, unknown>;
      const providers = ensureRecord(config, "provider");
      let newId = "new-provider";
      let counter = 1;
      while (providers[newId]) {
        counter += 1;
        newId = `new-provider-${counter}`;
      }
      const newModelId = "default";
      providers[newId] = {
        name: newId,
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.openai.com/v1", apiKey: "" },
        models: { [newModelId]: { name: newModelId } }
      };
      if (!valueAsString(config.model)) {
        config.model = `${newId}/${newModelId}`;
      }
      const next = `${JSON.stringify(config, null, 2)}\n`;
      setJsonText(next);
      syncFromParsed(next, `${newId}/${newModelId}`);
    } catch (addError) {
      setError(errorMessage(addError));
    }
  }

  function handleDeleteProvider() {
    setError("");
    try {
      const draft = flushCurrentProviderDraft();
      const config = JSON.parse(draft) as Record<string, unknown>;
      const providers = asRecord(config.provider);
      const keys = Object.keys(providers);
      if (keys.length <= 1) {
        setError(t("settings.cannotDeleteLastProvider"));
        return;
      }
      const currentId = providerId;
      if (currentId && providers[currentId] !== undefined) {
        delete providers[currentId];
      }
      const nextId = keys.find((key) => key !== currentId) ?? "";
      const nextProvider = asRecord(providers[nextId]);
      const nextModels = asRecord(nextProvider.models);
      const nextModelId = Object.keys(nextModels)[0] ?? "default";
      const modelStr = valueAsString(config.model);
      if (modelStr && (modelStr === currentId || modelStr.startsWith(`${currentId}/`))) {
        config.model = `${nextId}/${nextModelId}`;
      }
      const next = `${JSON.stringify(config, null, 2)}\n`;
      setJsonText(next);
      syncFromParsed(next, `${nextId}/${nextModelId}`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    }
  }

  async function handlePickConfigFile() {
    setError("");
    try {
      let draft = jsonText;
      try {
        draft = buildProviderConfigContent(jsonText, currentFields());
      } catch {
        draft = jsonText;
      }
      const dirty = draft !== configContent || selectedConfigPath !== configPath;
      if (dirty && !window.confirm(t("settings.discardConfigDraft"))) {
        return;
      }
      const selected = await pickProviderConfigFile();
      if (!selected) {
        return;
      }
      const config = await onLoadConfigFile(selected);
      setSelectedConfigPath(config.path);
      setJsonText(config.content);
      syncFromParsed(config.content, config.selectedProviderId ?? "");
      await syncPersistedCapabilities(config.path);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }

  function openMcpNewForm() {
    setMcpEditing({
      id: "", enabled: true, command: "", args: [], env: {},
      cwd: null, timeoutSeconds: 60, requireApproval: true, readOnly: false
    });
    setMcpIsNew(true);
    setMcpFormId("");
    setMcpFormCommand("");
    setMcpFormArgs("");
    setMcpFormEnvPairs([{ key: "", value: "" }]);
    setMcpFormCwd("");
    setMcpFormTimeout(60);
    setMcpFormRequireApproval(true);
    setMcpFormReadOnly(false);
    setMcpFormEnabled(true);
    setMcpTestResult(null);
  }

  function openMcpEditForm(server: McpServerConfig) {
    setMcpEditing(server);
    setMcpIsNew(false);
    setMcpFormId(server.id);
    setMcpFormCommand(server.command);
    setMcpFormArgs(server.args.join("\n"));
    const pairs = Object.entries(server.env).map(([key, value]) => ({ key, value }));
    setMcpFormEnvPairs(pairs.length > 0 ? pairs : [{ key: "", value: "" }]);
    setMcpFormCwd(server.cwd ?? "");
    setMcpFormTimeout(server.timeoutSeconds);
    setMcpFormRequireApproval(server.requireApproval);
    setMcpFormReadOnly(server.readOnly);
    setMcpFormEnabled(server.enabled);
    setMcpTestResult(null);
  }

  function mcpFormToServer(): McpServerConfig {
    const env: Record<string, string> = {};
    for (const pair of mcpFormEnvPairs) {
      if (pair.key.trim()) env[pair.key.trim()] = pair.value;
    }
    return {
      id: mcpFormId.trim(),
      enabled: mcpFormEnabled,
      command: mcpFormCommand.trim(),
      args: mcpFormArgs.split("\n").map((a) => a.trim()).filter(Boolean),
      env,
      cwd: mcpFormCwd.trim() || null,
      timeoutSeconds: mcpFormTimeout || 60,
      requireApproval: mcpFormRequireApproval,
      readOnly: mcpFormReadOnly
    };
  }

  async function syncPersistedCapabilities(targetConfigPath = selectedConfigPath) {
    const capabilities = await onRefreshCapabilities(targetConfigPath || null);
    if (capabilities) {
      setSelectedConfigPath(capabilities.configPath);
      setMcpServers(capabilities.mcpServers);
      setSkills(capabilities.skills);
      setSkillExpanded((current) =>
        current && capabilities.skills.some((skill) => skill.path === current)
          ? current
          : null
      );
    }
    return capabilities;
  }

  function applyPersistedMcpServers(response: McpConfigFileResponse) {
    setSelectedConfigPath(response.path);
    setMcpServers(response.mcpServers);
    setJsonText(response.content);
    onMcpConfigChanged(response);
  }

  async function handleMcpSave() {
    setError("");
    const server = mcpFormToServer();
    if (!server.id) { setError(t("settings.mcpServerIdRequired")); return; }
    if (!server.command) { setError(t("settings.mcpCommandRequired")); return; }
    if (mcpIsNew && mcpServers.some((s) => s.id === server.id)) {
      setError(t("settings.mcpDuplicateId", { id: server.id })); return;
    }
    try {
      const response = await saveMcpServer(projectRoot, server, selectedConfigPath || null);
      applyPersistedMcpServers(response);
      setMcpEditing(null);
      setMcpShowJsonImport(false);
      await syncPersistedCapabilities(response.path);
    } catch (e) { setError(errorMessage(e)); }
  }

  async function handleMcpDelete(id: string) {
    setError("");
    if (!window.confirm(t("settings.mcpConfirmDelete", { id }))) return;
    try {
      const response = await deleteMcpServer(projectRoot, id, selectedConfigPath || null);
      applyPersistedMcpServers(response);
      if (mcpEditing?.id === id) setMcpEditing(null);
      await syncPersistedCapabilities(response.path);
    } catch (e) { setError(errorMessage(e)); }
  }

  async function handleMcpTest() {
    setError("");
    const server = mcpFormToServer();
    if (!server.command) { setError(t("settings.mcpCommandRequired")); return; }
    setMcpTesting(true);
    setMcpTestResult(null);
    try {
      const tools = await testMcpConnection(projectRoot, server);
      setMcpTestResult({ ok: true, tools });
    } catch (e) {
      setMcpTestResult({ ok: false, tools: [], error: errorMessage(e) });
    } finally { setMcpTesting(false); }
  }

  async function handleMcpJsonImport() {
    setError("");
    const text = mcpJsonText.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      let serversMap: Record<string, Record<string, unknown>> = {};
      if (parsed.mcp && typeof parsed.mcp === "object") {
        const mcpObj = parsed.mcp as Record<string, unknown>;
        if (mcpObj.servers && typeof mcpObj.servers === "object") {
          serversMap = mcpObj.servers as Record<string, Record<string, unknown>>;
        }
      } else if (parsed.servers && typeof parsed.servers === "object") {
        serversMap = parsed.servers as Record<string, Record<string, unknown>>;
      } else if (parsed.command && typeof parsed.command === "string") {
        const id = (parsed.id as string) || "imported-server";
        serversMap = { [id]: parsed };
      } else {
        serversMap = parsed as Record<string, Record<string, unknown>>;
      }
      const entries = Object.entries(serversMap);
      if (entries.length === 0) { setError(t("settings.mcpImportNoServers")); return; }
      let response: McpConfigFileResponse | null = null;
      for (const [id, config] of entries) {
        const server = mcpServerFromImport(id, config);
        if (!server) continue;
        if (!server.command) continue;
        response = await saveMcpServer(projectRoot, server, selectedConfigPath || null);
      }
      if (!response) { setError(t("settings.mcpImportNoServers")); return; }
      applyPersistedMcpServers(response);
      setMcpJsonText("");
      setMcpShowJsonImport(false);
      await syncPersistedCapabilities(response.path);
    } catch (e) { setError(errorMessage(e)); }
  }

  async function handleSkillImport() {
    setError("");
    try {
      const filePath = await pickSkillFile();
      if (!filePath) return;
      const record = await importSkill(projectRoot, filePath);
      setSkills((prev) => {
        const filtered = prev.filter((s) => s.path !== record.path);
        return [...filtered, record];
      });
      await syncPersistedCapabilities();
    } catch (e) { setError(errorMessage(e)); }
  }

  async function handleSkillDelete(skill: SkillRecord) {
    setError("");
    if (!window.confirm(t("settings.skillConfirmDelete", { name: skill.name }))) return;
    try {
      await deleteSkill(projectRoot, skill.path);
      setSkills((prev) => prev.filter((s) => s.path !== skill.path));
      if (skillExpanded === skill.path) setSkillExpanded(null);
      await syncPersistedCapabilities();
    } catch (e) { setError(errorMessage(e)); }
  }

  async function handleSkillToggleContent(skill: SkillRecord) {
    if (skillExpanded === skill.path) { setSkillExpanded(null); return; }
    setSkillExpanded(skill.path);
    if (!skillContents[skill.path]) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ name: string; description: string; path: string; content: string }>(
          "read_skill_content", {
            projectRoot,
            configPath: selectedConfigPath || null,
            nameOrPath: skill.name
          }
        );
        setSkillContents((prev) => ({ ...prev, [skill.path]: result.content }));
      } catch {
        setSkillContents((prev) => ({ ...prev, [skill.path]: "(无法加载内容)" }));
      }
    }
  }

  return (
    <div className="modalBackdrop" role="presentation">
      <section className="settingsModal" role="dialog" aria-modal="true">
        <header className="modalHeader">
          <div>
            <strong>{t("settings.title")}</strong>
            <small>{selectedConfigPath || configPath || t("settings.configNotLoaded")}</small>
          </div>
          <button className="iconButton ghost" onClick={onClose} aria-label={t("settings.close")}>
            <X size={16} />
          </button>
        </header>

        <div className="settingsBody">
          {error && <pre className="modalError">{error}</pre>}

          <div className="configFileActions">
            <div>
              <span>{t("settings.configFile")}</span>
              <strong>{selectedConfigPath || configPath || t("settings.configNotLoaded")}</strong>
              {projectRoot && <small>{projectRoot}</small>}
            </div>
            <button className="presetButton" type="button" onClick={() => void handlePickConfigFile()}>
              <FileCode2 size={14} />
              {t("settings.switchConfigFile")}
            </button>
          </div>

          {projectCapabilities && (
            <div className="capabilitySummary">
              <span>{t("settings.capabilities")}</span>
              <strong>
                {t("settings.capabilityCounts", {
                  skills: projectCapabilities.skills.length,
                  servers: projectCapabilities.mcpServers.filter((server) => server.enabled).length,
                  tools: projectCapabilities.mcpTools.length
                })}
              </strong>
              {projectCapabilities.errors.length > 0 && (
                <small>
                  {projectCapabilities.errors
                    .map((item) => `${item.source}: ${item.message}`)
                    .join(" · ")}
                </small>
              )}
            </div>
          )}

          <div className="settingsTabs">
            <button type="button" className={activeTab === "ai" ? "active" : ""} onClick={() => setActiveTab("ai")}>
              {t("settings.tabAi")}
            </button>
            <button type="button" className={activeTab === "mcp" ? "active" : ""} onClick={() => setActiveTab("mcp")}>
              {t("settings.tabMcp")}
            </button>
            <button type="button" className={activeTab === "skills" ? "active" : ""} onClick={() => setActiveTab("skills")}>
              {t("settings.tabSkills")}
            </button>
          </div>

          {activeTab === "ai" && (<>
          <div className="settingsGrid">
            <label>
              <span>{t("settings.provider")}</span>
              <select
                value={providerId}
                onChange={(event) => {
                  setError("");
                  try {
                    syncFromSelection(event.target.value);
                  } catch (selectionError) {
                    setError(errorMessage(selectionError));
                  }
                }}
              >
                {providerOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <div className="settingsField">
              <span>{t("settings.model")}</span>
              <ModelReasoningPicker
                isOpen={modelPickerOpen}
                modelId={modelId}
                modelOptions={modelOptions}
                efforts={reasoningEfforts}
                value={reasoningEffort}
                isLoading={isReasoningLoading}
                isSaving={isReasoningSaving}
                onOpenChange={openModelPicker}
                onSelectModel={(nextModelId) => {
                  setError("");
                  try {
                    syncFromSelection(providerId, nextModelId);
                  } catch (selectionError) {
                    setError(errorMessage(selectionError));
                  }
                }}
                onChangeEffort={handleReasoningEffortChange}
              />
            </div>
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
            <ToggleSwitch
              className="settingsWide"
              label={t("settings.supportsResponses")}
              checked={supportsResponses}
              onChange={setSupportsResponses}
            />
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

          <div className="providerActions">
            <button className="presetButton" type="button" onClick={handleAddProvider}>
              <Plus size={14} />
              {t("settings.addProvider")}
            </button>
            <button className="presetButton" type="button" onClick={handleDeleteProvider}>
              <Trash2 size={14} />
              {t("settings.deleteProvider")}
            </button>
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
                setSupportsResponses(parsed.supportsResponses);
                setResponsesSource(parsed.responsesSource);
                setReasoningEffort(parsed.reasoningEffort);
                if (modelPickerOpen) {
                  void loadReasoningEfforts(
                    event.target.value,
                    parsed.providerId,
                    parsed.modelId
                  );
                }
              }}
              spellCheck={false}
            />
          )}
          </>)}

          {activeTab === "mcp" && (
            <div className="settingsTabPanel">
              {mcpServers.length === 0 && !mcpEditing && (
                <p className="settingsEmptyHint">{t("settings.mcpNoServers")}</p>
              )}

              {mcpServers.length > 0 && !mcpEditing && (
                <div className="configList">
                  {mcpServers.map((server) => (
                    <div key={server.id} className="configListItem">
                      <div className="configListInfo">
                        <strong>{server.id}</strong>
                        <small>{server.command} {server.args.join(" ")}</small>
                        <span className={`configListBadge ${server.enabled ? "on" : "off"}`}>
                          {server.enabled ? "ON" : "OFF"}
                        </span>
                      </div>
                      <div className="configListActions">
                        <button className="iconButton ghost" type="button" onClick={() => openMcpEditForm(server)}>
                          <Pencil size={14} />
                        </button>
                        <button className="iconButton ghost" type="button" onClick={() => void handleMcpDelete(server.id)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {mcpEditing && (
                <div className="mcpForm">
                  <label>
                    <span>{t("settings.mcpServerId")}</span>
                    <input
                      value={mcpFormId}
                      onChange={(e) => setMcpFormId(e.target.value)}
                      disabled={!mcpIsNew}
                      placeholder="my-server"
                    />
                  </label>
                  <label>
                    <span>{t("settings.mcpCommand")}</span>
                    <input
                      value={mcpFormCommand}
                      onChange={(e) => setMcpFormCommand(e.target.value)}
                      placeholder="npx"
                    />
                  </label>
                  <label className="settingsWide">
                    <span>{t("settings.mcpArgs")}</span>
                    <textarea
                      className="mcpArgsEditor"
                      value={mcpFormArgs}
                      onChange={(e) => setMcpFormArgs(e.target.value)}
                      placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
                      rows={3}
                      spellCheck={false}
                    />
                  </label>
                  <label className="settingsWide">
                    <span>{t("settings.mcpEnv")}</span>
                    <div className="mcpEnvList">
                      {mcpFormEnvPairs.map((pair, idx) => (
                        <div key={idx} className="mcpEnvRow">
                          <input
                            value={pair.key}
                            onChange={(e) => {
                              const next = [...mcpFormEnvPairs];
                              next[idx] = { ...next[idx], key: e.target.value };
                              setMcpFormEnvPairs(next);
                            }}
                            placeholder={t("settings.mcpEnvKey")}
                          />
                          <input
                            value={pair.value}
                            onChange={(e) => {
                              const next = [...mcpFormEnvPairs];
                              next[idx] = { ...next[idx], value: e.target.value };
                              setMcpFormEnvPairs(next);
                            }}
                            placeholder={t("settings.mcpEnvValue")}
                          />
                          <button className="iconButton ghost" type="button" onClick={() => {
                            setMcpFormEnvPairs(mcpFormEnvPairs.filter((_, i) => i !== idx));
                          }}>
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      <button className="presetButton small" type="button" onClick={() => {
                        setMcpFormEnvPairs([...mcpFormEnvPairs, { key: "", value: "" }]);
                      }}>
                        <Plus size={12} />
                      </button>
                    </div>
                  </label>
                  <label>
                    <span>{t("settings.mcpCwd")}</span>
                    <input
                      value={mcpFormCwd}
                      onChange={(e) => setMcpFormCwd(e.target.value)}
                      placeholder="."
                    />
                  </label>
                  <label>
                    <span>{t("settings.mcpTimeout")}</span>
                    <input
                      type="number"
                      min={1}
                      max={600}
                      value={mcpFormTimeout}
                      onChange={(e) => setMcpFormTimeout(Number(e.target.value))}
                    />
                  </label>
                  <ToggleSwitch
                    className="settingsWide"
                    label={t("settings.mcpEnabled")}
                    checked={mcpFormEnabled}
                    onChange={setMcpFormEnabled}
                  />
                  <ToggleSwitch
                    className="settingsWide"
                    label={t("settings.mcpRequireApproval")}
                    checked={mcpFormRequireApproval}
                    onChange={setMcpFormRequireApproval}
                  />
                  <ToggleSwitch
                    className="settingsWide"
                    label={t("settings.mcpReadOnly")}
                    checked={mcpFormReadOnly}
                    onChange={setMcpFormReadOnly}
                  />

                  <div className="mcpFormActions">
                    <button className="presetButton" type="button" onClick={() => void handleMcpTest()} disabled={mcpTesting}>
                      {mcpTesting ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                      {mcpTesting ? t("settings.mcpTesting") : t("settings.mcpTest")}
                    </button>
                    <button className="commandButton modalSaveButton" type="button" onClick={() => void handleMcpSave()}>
                      <Save size={14} />
                      {t("settings.mcpSave")}
                    </button>
                    <button className="iconTextButton" type="button" onClick={() => { setMcpEditing(null); setMcpTestResult(null); }}>
                      {t("settings.mcpCancel")}
                    </button>
                  </div>

                  {mcpTestResult && (
                    <div className={mcpTestResult.ok ? "mcpTestSuccess" : "mcpTestError"}>
                      {mcpTestResult.ok ? (
                        <>
                          <strong>{t("settings.mcpTestSuccess", { count: mcpTestResult.tools.length })}</strong>
                          {mcpTestResult.tools.length > 0 && (
                            <ul className="mcpToolList">
                              {mcpTestResult.tools.map((tool) => (
                                <li key={tool.name}>
                                  <strong>{tool.name}</strong>
                                  {tool.description && <small>{tool.description}</small>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <span>{t("settings.mcpTestFail")}: {mcpTestResult.error}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!mcpEditing && (
                <div className="mcpToolbar">
                  <button className="presetButton" type="button" onClick={openMcpNewForm}>
                    <Plus size={14} />
                    {t("settings.mcpAdd")}
                  </button>
                  <button className="presetButton" type="button" onClick={() => { setMcpShowJsonImport(!mcpShowJsonImport); setMcpJsonText(""); }}>
                    <FileCode2 size={14} />
                    {t("settings.mcpImportJson")}
                  </button>
                </div>
              )}

              {mcpShowJsonImport && !mcpEditing && (
                <div className="mcpJsonImport">
                  <textarea
                    className="settingsJsonEditor"
                    value={mcpJsonText}
                    onChange={(e) => setMcpJsonText(e.target.value)}
                    placeholder={t("settings.mcpImportJsonPlaceholder")}
                    rows={8}
                    spellCheck={false}
                  />
                  <button className="commandButton modalSaveButton" type="button" onClick={() => void handleMcpJsonImport()}>
                    {t("settings.mcpImportJsonSubmit")}
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === "skills" && (
            <div className="settingsTabPanel">
              {skills.length === 0 && (
                <p className="settingsEmptyHint">{t("settings.skillNoSkills")}</p>
              )}

              {skills.length > 0 && (
                <div className="configList">
                  {skills.map((skill) => (
                    <div key={skill.path} className="configListItem skillItem">
                      <div className="configListInfo">
                        <button className="skillNameBtn" type="button" onClick={() => void handleSkillToggleContent(skill)}>
                          {skillExpanded === skill.path ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <strong>{skill.name}</strong>
                        </button>
                        {skill.description && <small>{skill.description}</small>}
                        <small className="skillPath">{skill.path}</small>
                      </div>
                      <div className="configListActions">
                        <button className="iconButton ghost" type="button" onClick={() => void handleSkillDelete(skill)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {skillExpanded && skillContents[skillExpanded] && (
                <pre className="skillContentPreview">{skillContents[skillExpanded]}</pre>
              )}

              <div className="mcpToolbar">
                <button className="presetButton" type="button" onClick={() => void handleSkillImport()}>
                  <Upload size={14} />
                  {t("settings.skillImport")}
                </button>
              </div>
            </div>
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

function ModelReasoningPicker({
  isOpen,
  modelId,
  modelOptions,
  efforts,
  value,
  isLoading,
  isSaving,
  onOpenChange,
  onSelectModel,
  onChangeEffort
}: {
  isOpen: boolean;
  modelId: string;
  modelOptions: string[];
  efforts: ReasoningEffort[];
  value: ReasoningEffortSetting;
  isLoading: boolean;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectModel: (modelId: string) => void;
  onChangeEffort: (effort: ReasoningEffortSetting) => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sliderOptions = useMemo<ReasoningEffortSetting[]>(
    () => ["", ...efforts],
    [efforts]
  );
  const selectedValue: ReasoningEffortSetting =
    value && sliderOptions.includes(value) ? value : "";
  const selectedIndex = Math.max(0, sliderOptions.indexOf(selectedValue));

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const closeOnOutside = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isOpen, onOpenChange]);

  return (
    <div className="modelReasoningPicker" ref={rootRef}>
      <button
        className="modelPickerTrigger"
        type="button"
        onClick={() => onOpenChange(!isOpen)}
        aria-expanded={isOpen}
        aria-label={t("settings.modelPickerOpen")}
      >
        <span>{modelId || t("settings.model")}</span>
        <ChevronDown size={15} />
      </button>

      {isOpen && (
        <div className="modelPickerPanel">
          <div className="modelPickerList">
            {modelOptions.map((item) => (
              <button
                key={item}
                type="button"
                className={item === modelId ? "active" : ""}
                onClick={() => onSelectModel(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="reasoningSliderPanel">
            <div className="reasoningSliderHeader">
              <span>
                <BrainCircuit size={14} />
                {t("settings.reasoningEffort")}
              </span>
              <strong>{reasoningEffortLabel(selectedValue, t)}</strong>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, sliderOptions.length - 1)}
              step={1}
              value={selectedIndex}
              disabled={isLoading || sliderOptions.length <= 1}
              onChange={(event) => {
                const nextIndex = Number(event.target.value);
                onChangeEffort(sliderOptions[nextIndex] ?? "");
              }}
            />
            <div
              className="reasoningTicks"
              style={{ gridTemplateColumns: `repeat(${sliderOptions.length}, minmax(0, 1fr))` }}
            >
              {sliderOptions.map((item) => (
                <span key={item || "auto"}>{reasoningEffortLabel(item, t)}</span>
              ))}
            </div>
            {(isLoading || isSaving || efforts.length === 0) && (
              <small className="reasoningStatus">
                {isLoading
                  ? t("settings.reasoningLoading")
                  : isSaving
                    ? t("settings.reasoningSaving")
                    : t("settings.reasoningUnavailable")}
              </small>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function reasoningEffortLabel(
  effort: ReasoningEffortSetting,
  t: (key: string) => string
) {
  if (!effort) {
    return t("settings.reasoningAuto");
  }
  const labels: Record<ReasoningEffort, string> = {
    none: t("settings.reasoningNone"),
    minimal: t("settings.reasoningMinimal"),
    low: t("settings.reasoningLow"),
    medium: t("settings.reasoningMedium"),
    high: t("settings.reasoningHigh"),
    xhigh: t("settings.reasoningXhigh"),
    max: t("settings.reasoningMax")
  };
  return labels[effort];
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
  | "mcpTool"
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

type TimelineMcpTool = {
  serverId: string;
  toolName: string;
  displayName: string;
  statusText: string;
  summary: string;
  input?: unknown;
  output?: unknown;
  error?: string;
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
  mcpTool?: TimelineMcpTool;
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

function ConversationTimelineImpl({
  events,
  snapshots,
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
          stream={item.status === "running"}
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

function TimelineItemViewImpl({
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

        {item.kind === "mcpTool" && item.mcpTool && (
          <McpToolCard tool={item.mcpTool} />
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

function CodeChangeCardImpl({
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

function CodeChangeSummaryCardImpl({
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

function McpToolCardImpl({ tool }: { tool: TimelineMcpTool }) {
  const { t } = useTranslation();
  const hasPayload =
    tool.input !== undefined || tool.output !== undefined || Boolean(tool.error);
  return (
    <div className="mcpToolCard">
      <div className="mcpToolMeta">
        <span className="mcpToolBadge">
          <Network size={14} />
          MCP
        </span>
        <code>{tool.serverId}</code>
        <code>{tool.toolName}</code>
        <span>{tool.statusText}</span>
      </div>
      {tool.summary && <p className="mcpToolSummary">{tool.summary}</p>}
      {hasPayload && (
        <details className="mcpPayloadDetail">
          <summary>
            <ChevronRight size={13} />
            {t("common.viewDetails")}
          </summary>
          <div className="mcpPayloadList">
            {tool.input !== undefined && (
              <section>
                <strong>{t("mcp.input")}</strong>
                <pre>{formatJson(tool.input)}</pre>
              </section>
            )}
            {tool.error && (
              <section>
                <strong>{t("mcp.error")}</strong>
                <pre>{tool.error}</pre>
              </section>
            )}
            {tool.output !== undefined && (
              <section>
                <strong>{t("mcp.output")}</strong>
                <pre>{formatJson(tool.output)}</pre>
              </section>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

const LONG_MARKDOWN_CHARS = 1200;
const LONG_MARKDOWN_LINES = 18;

function MarkdownTextImpl({
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
  const visibleLengthRef = useRef(visibleLength);
  const previousTextRef = useRef(stream ? "" : text);

  useEffect(() => {
    setExpanded(!isLongMarkdown(normalizedText));
    if (!stream) {
      visibleLengthRef.current = text.length;
      previousTextRef.current = text;
      setVisibleLength(text.length);
      return undefined;
    }

    const total = Array.from(text).length;
    // When a streamed token simply extends the text we were already revealing,
    // keep the progress made so far — only rewind to 0 if the message was
    // replaced or shortened. This stops the reply from flashing back to empty
    // and re-typing on every token.
    const isAppend = text.startsWith(previousTextRef.current);
    previousTextRef.current = text;
    let revealed = isAppend ? Math.min(visibleLengthRef.current, total) : 0;
    visibleLengthRef.current = revealed;
    setVisibleLength(revealed);

    if (revealed >= total) {
      return undefined;
    }

    const step = Math.max(4, Math.ceil(total / 140));
    const timer = window.setInterval(() => {
      revealed = Math.min(total, revealed + step);
      visibleLengthRef.current = revealed;
      setVisibleLength(revealed);
      if (revealed >= total) {
        window.clearInterval(timer);
      }
    }, 18);

    return () => window.clearInterval(timer);
  }, [normalizedText, stream, text]);

  const displayText = stream
    ? Array.from(text).slice(0, visibleLength).join("")
    : normalizedText;
  const markdownText = stream ? normalizeInlineMarkdownTables(displayText) : displayText;
  const canCollapse = isLong && !stream;

  return (
    <div className={`markdownFrame ${canCollapse && !expanded ? "collapsed" : ""}`}>
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
      {canCollapse && (
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

type TodoExecutionSummary = {
  total: number;
  completed: number;
  active?: TodoRecord;
};

type PlanArtifact = {
  path: string;
};

function normalizeTodoStatus(status: string) {
  return status === "done" ? "completed" : status;
}

function buildTodoExecutionSummary(todos: TodoRecord[]): TodoExecutionSummary {
  const completed = todos.filter(
    (todo) => normalizeTodoStatus(todo.status) === "completed"
  ).length;
  const active =
    todos.find((todo) => normalizeTodoStatus(todo.status) === "in_progress") ??
    todos.find((todo) => normalizeTodoStatus(todo.status) === "pending") ??
    todos.filter((todo) => normalizeTodoStatus(todo.status) === "completed").at(-1);
  return {
    total: todos.length,
    completed,
    active
  };
}

function buildPlanArtifact(
  events: EventRecord[],
  snapshots: SnapshotRecord[]
): PlanArtifact | null {
  const planSnapshot = [...snapshots]
    .reverse()
    .find((snapshot) => isPlanDocumentPath(snapshot.path));
  const eventPath = latestPlanPathFromEvents(events);
  const path = planSnapshot?.path || eventPath;
  if (!path) {
    return null;
  }
  return {
    path
  };
}

function latestPlanPathFromEvents(events: EventRecord[]) {
  for (const event of [...events].reverse()) {
    if (event.type === "plan.persisted") {
      const path = valueAsString(event.data.path);
      if (path) {
        return path;
      }
    }
    if (event.type === "tool.pending" || event.type === "tool.success") {
      const pending = asRecord(event.data.pending);
      const result = asRecord(event.data.result);
      const path =
        valueAsString(pending.planPath) ||
        valueAsString(result.planPath) ||
        valueAsString(event.data.planPath);
      if (path) {
        return path;
      }
    }
  }
  return "";
}

function isPlanDocumentPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith(".odot/plans/") && normalized.endsWith(".md");
}

function PlanExecutionDock({
  events,
  onDismiss,
  plan,
  sessionId,
  snapshots,
  todos
}: {
  events: EventRecord[];
  onDismiss?: () => void;
  plan: PlanArtifact | null;
  sessionId: string;
  snapshots: SnapshotRecord[];
  todos: TodoRecord[];
}) {
  const { t } = useTranslation();
  const [openError, setOpenError] = useState("");
  const summary = buildExecutionSummary(events, snapshots);
  const todoSummary = useMemo(() => buildTodoExecutionSummary(todos), [todos]);
  const todoProgress =
    todoSummary.total > 0 ? Math.round((todoSummary.completed / todoSummary.total) * 100) : 0;

  return (
    <section className="rightSection planExecutionDock">
      <header className="planExecutionHeader">
        <div className="planExecutionTitle">
          <History size={16} />
          <strong>{t("nav.planProgress")}</strong>
          <span className={summary.status}>{summary.statusText}</span>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="planDockDismissButton"
            onClick={onDismiss}
            title={t("common.close", { defaultValue: "Close" })}
          >
            <X size={14} />
          </button>
        )}
      </header>
      <div className="planDocumentCard">
        <div className="planDocumentHeader">
          <div>
            <strong>
              <FileText size={14} />
              {t("todo.planDocument")}
            </strong>
            <code>{plan?.path || t("todo.noPlanDocument")}</code>
          </div>
          <button
            type="button"
            className="iconTextButton compact"
            disabled={!plan?.path || !sessionId}
            onClick={async () => {
              if (!plan?.path || !sessionId) {
                return;
              }
              setOpenError("");
              try {
                await revealProjectPath({ sessionId, path: plan.path });
              } catch (error) {
                setOpenError(errorSummary(String(error)));
              }
            }}
          >
            <FolderOpen size={14} />
            <span>{t("todo.openInFileManager")}</span>
          </button>
        </div>
        {openError && <small className="inlineError">{openError}</small>}
      </div>
      <div className="planTodoBlock">
        <div className="planTodoProgressRow">
          <strong>
            {todoSummary.total
              ? t("todo.progress", {
                  completed: todoSummary.completed,
                  total: todoSummary.total
                })
              : t("todo.waiting")}
          </strong>
          <span>{todoProgress}%</span>
        </div>
        <div className="planTodoProgressTrack" aria-hidden="true">
          <span style={{ width: `${todoProgress}%` }} />
        </div>
        <PlanTodoTimeline todos={todos} />
      </div>
    </section>
  );
}

function PlanTodoTimeline({ todos }: { todos: TodoRecord[] }) {
  const { t } = useTranslation();
  const timelineTodos =
    todos.length > 0
      ? todos
      : [
          {
            content: t("todo.waitingForTodoWrite"),
            status: "pending",
            priority: "medium",
            position: 0
          }
        ];

  return (
    <ol className="planTimeline">
      {timelineTodos.map((todo) => {
        const status = normalizeTodoStatus(todo.status);
        return (
          <li
            className={`planTimelineItem ${status}`}
            key={`${todo.position}-${todo.content}`}
          >
            <span className="planTimelineMarker">
              {status === "completed" && <Check size={13} />}
              {status === "in_progress" && <Loader2 className="spin" size={13} />}
              {status === "cancelled" && <X size={13} />}
              {status !== "completed" &&
                status !== "in_progress" &&
                status !== "cancelled" && <Clock3 size={13} />}
            </span>
            <span className="planTimelineContent">{todo.content}</span>
          </li>
        );
      })}
    </ol>
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
  const pendingById = new Map<string, EventRecord>();
  const resultByToolCall = new Map<string, EventRecord>();
  const resultByPending = new Map<string, EventRecord>();
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
      continue;
    }
    if (event.type === "tool.pending") {
      pendingById.set(event.id, event);
    }
    const pendingEventId = valueAsString(event.data.pendingEventId);
    if (
      pendingEventId &&
      (event.type === "tool.success" ||
        event.type === "tool.failed" ||
        event.type === "tool.rejected")
    ) {
      resultByPending.set(pendingEventId, event);
    }
  }
  for (const event of events) {
    const toolCallEventId = valueAsString(event.data.toolCallEventId);
    if (
      toolCallEventId &&
      (event.type === "tool.success" ||
        event.type === "tool.failed" ||
        event.type === "tool.pending")
    ) {
      resultByToolCall.set(
        toolCallEventId,
        event.type === "tool.pending" ? (resultByPending.get(event.id) ?? event) : event
      );
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

    if (event.type === "tool.called" && isMcpToolEvent(event)) {
      pushItem(mcpTimelineItem(event, resultByToolCall.get(event.id)));
      continue;
    }

    if (isMcpToolResultEvent(event)) {
      const toolCallEventId = valueAsString(event.data.toolCallEventId);
      const pendingEventId = valueAsString(event.data.pendingEventId);
      const pendingToolCallEventId = valueAsString(
        pendingById.get(pendingEventId)?.data.toolCallEventId
      );
      if (
        (!toolCallEventId || !callById.has(toolCallEventId)) &&
        (!pendingToolCallEventId || !callById.has(pendingToolCallEventId))
      ) {
        pushItem(mcpTimelineItem(null, event));
      }
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

function isMcpToolEvent(event: EventRecord) {
  return valueAsString(event.data.name).startsWith("mcp__");
}

function isMcpToolResultEvent(event: EventRecord) {
  if (
    event.type !== "tool.success" &&
    event.type !== "tool.failed" &&
    event.type !== "tool.pending" &&
    event.type !== "tool.rejected"
  ) {
    return false;
  }
  if (isMcpToolEvent(event)) {
    return true;
  }
  const result = asRecord(event.data.result);
  const pending = asRecord(event.data.pending);
  const pendingMcp = asRecord(pending.mcp);
  const mcp = asRecord(event.data.mcp);
  return Boolean(
    valueAsString(result.serverId) ||
      valueAsString(result.toolName) ||
      valueAsString(pendingMcp.serverId) ||
      valueAsString(pendingMcp.toolName) ||
      valueAsString(mcp.serverId) ||
      valueAsString(mcp.toolName)
  );
}

function mcpTimelineItem(
  callEvent: EventRecord | null | undefined,
  resultEvent: EventRecord | null | undefined
): TimelineItem {
  const event = callEvent ?? resultEvent;
  const status: Exclude<TimelineStatus, "neutral"> =
    resultEvent?.type === "tool.failed" || resultEvent?.type === "tool.rejected"
      ? "failed"
      : resultEvent?.type === "tool.pending"
        ? "waiting"
        : resultEvent?.type === "tool.success"
          ? "done"
          : "running";
  const statusText =
    status === "failed"
      ? appT("execution.failed")
      : status === "waiting"
        ? appT("execution.waiting")
        : status === "running"
          ? appT("execution.running")
          : appT("execution.done");
  const tool = mcpToolSummary(callEvent, resultEvent, statusText);
  return {
    id: callEvent?.id ?? resultEvent?.id ?? `mcp-${tool.displayName}`,
    kind: "mcpTool",
    title: appT("mcp.toolCall"),
    text: tool.summary,
    status,
    event: event ?? undefined,
    details: [callEvent, resultEvent].filter((item): item is EventRecord => Boolean(item)),
    mcpTool: tool
  };
}

function mcpToolSummary(
  callEvent: EventRecord | null | undefined,
  resultEvent: EventRecord | null | undefined,
  statusText: string
): TimelineMcpTool {
  const name = valueAsString(callEvent?.data.name) || valueAsString(resultEvent?.data.name);
  const parsed = parseMcpDisplayName(name);
  const result = asRecord(resultEvent?.data.result);
  const mcp = asRecord(resultEvent?.data.mcp);
  const pending = asRecord(resultEvent?.data.pending);
  const pendingMcp = asRecord(pending.mcp);
  const serverId =
    valueAsString(result.serverId) ||
    valueAsString(mcp.serverId) ||
    valueAsString(pendingMcp.serverId) ||
    parsed.serverId ||
    appT("mcp.unknownServer");
  const toolName =
    valueAsString(result.toolName) ||
    valueAsString(mcp.toolName) ||
    valueAsString(pendingMcp.toolName) ||
    parsed.toolName ||
    name ||
    appT("mcp.unknownTool");
  const input =
    callEvent?.data.input ??
    resultEvent?.data.input ??
    pendingMcp.arguments;
  const error = valueAsString(result.error) || valueAsString(resultEvent?.data.error);
  const output =
    result.content ??
    result.result ??
    (Object.keys(result).length && !error ? result : undefined);
  const reason = valueAsString(pending.reason);
  const summary = error
    ? error
    : reason
      ? reason
      : `${serverId} / ${toolName}`;
  return {
    serverId,
    toolName,
    displayName: name || `${serverId}/${toolName}`,
    statusText,
    summary,
    input,
    output,
    error
  };
}

function parseMcpDisplayName(name: string) {
  if (!name.startsWith("mcp__")) {
    return { serverId: "", toolName: "" };
  }
  const [, serverId = "", ...toolParts] = name.split("__");
  return {
    serverId,
    toolName: toolParts.join("__")
  };
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
  if (item.kind === "mcpTool") {
    return <Network size={16} />;
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

function ToggleSwitch({
  label,
  checked,
  onChange,
  disabled = false,
  className = ""
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={`settingSwitchRow ${className}`.trim()}>
      <span>{label}</span>
      <button
        type="button"
        className="switchControl"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
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
  const pending = event.data.pending as Record<string, unknown> | undefined;
  return (
    valueAsString(pending?.command) ||
    valueAsString(pending?.question) ||
    valueAsString(pending?.reason) ||
    valueAsString(event.data.command) ||
    appT("event.pendingCommand")
  );
}

function isShellPending(event: EventRecord) {
  return normalizeDisplayToolName(valueAsString(event.data.name)) === "shell";
}

function visiblePermissionRequests(requests: PermissionRequestRecord[]) {
  return requests.filter(
    (request) => request.status === "pending" && !isToolPermissionRequest(request)
  );
}

function formatBackgroundJob(job: BackgroundJobRecord) {
  if (job.command.startsWith("task:")) {
    const childSessionId = job.command.slice("task:".length);
    return `${appT("common.subAgent")} · ${job.status} · ${childSessionId.slice(0, 8)}`;
  }
  return `${job.status} #${job.pid} ${job.command}`;
}

function isRecoverableBackgroundJob(job: BackgroundJobRecord) {
  return job.command.startsWith("task:") && (job.status === "recoverable" || job.status === "orphaned");
}

function formatQueuedInput(input: SessionInputRecord) {
  const delivery = input.delivery === "steer" ? "steer" : "queue";
  const prompt = input.prompt.trim().replace(/\s+/g, " ");
  return `${delivery} - ${prompt.length > 96 ? `${prompt.slice(0, 96)}...` : prompt}`;
}

function latestActivityPause(events: EventRecord[]) {
  for (const event of [...events].reverse()) {
    if (
      event.type === "run.activity.started" ||
      event.type === "prompt.submitted" ||
      event.type === "session.input.promoted"
    ) {
      return null;
    }
    if (
      event.type === "run.activity.limit_reached" ||
      event.type === "run.activity.early_stop"
    ) {
      return { event };
    }
  }
  return null;
}

function activityPauseDescription(event: EventRecord) {
  if (event.type === "run.activity.limit_reached") {
    const step = valueAsNumber(event.data.step);
    const limit = valueAsNumber(event.data.limit);
    return `This activity stopped at step ${step ?? limit ?? "the limit"}. Continue to start the next bounded activity.`;
  }
  const repeatedCount = valueAsNumber(event.data.repeatedCount);
  const limit = valueAsNumber(event.data.limit);
  return `This activity stopped after ${repeatedCount ?? limit ?? "several"} repeated model actions. Continue only if the task still needs another attempt.`;
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
    event.type === "run.activity.ended" ||
    event.type === "run.activity.limit_reached" ||
    event.type === "run.activity.early_stop" ||
    (event.type === "session.checkpoint.saved" && event.data.status !== "running") ||
    (event.type === "step.ended" && (event.data.done === true || event.data.pending === true))
  );
}

function sessionEventShowsWork(event: EventRecord) {
  return (
    (event.type === "session.checkpoint.saved" && event.data.status === "running") ||
    event.type === "run.activity.started" ||
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

function parseReasoningEffort(value: string): ReasoningEffortSetting {
  return isReasoningEffort(value) ? value : "";
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function formatJson(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function extractExecutablePlanText(value: string) {
  const match = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(value);
  const planText = match?.[1]?.trim();
  return planText ? planText : null;
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

function configPathPreferenceKey(projectRoot: string) {
  return `odot.selectedConfigPath:${projectRoot.trim() || "__app__"}`;
}

function slashTokenAtCursor(value: string, cursor: number) {
  const left = value.slice(0, cursor);
  const match = /(^|\s)\/([^\s/]*)$/.exec(left);
  if (!match) {
    return null;
  }
  const slashOffset = match[1].length;
  return {
    start: left.length - match[0].length + slashOffset,
    end: cursor,
    query: match[2] ?? ""
  };
}

function selectedConfigPathForProject(projectRoot: string) {
  return localStorage.getItem(configPathPreferenceKey(projectRoot)) || null;
}

function rememberConfigPathForProject(projectRoot: string, configPath: string) {
  if (configPath.trim()) {
    localStorage.setItem(configPathPreferenceKey(projectRoot), configPath);
  }
}

function rememberLastSessionId(sessionId: string) {
  if (sessionId.trim()) {
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, sessionId);
  }
}

function clearLastSessionId(sessionId: string) {
  if (localStorage.getItem(LAST_SESSION_STORAGE_KEY) === sessionId) {
    localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
  }
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

function formatSessionUpdatedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function normalizeProjectRootKey(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function toolLabel(value: string) {
  const key = `tool.${value}`;
  const translated = appT(key);
  return translated === key ? value : translated;
}

function normalizeDisplayToolName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bash") {
    return "shell";
  }
  if (normalized === "grep") {
    return "search";
  }
  if (normalized === "todowrite") {
    return "todo_write";
  }
  if (normalized === "planexit") {
    return "plan_exit";
  }
  return normalized;
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

type ContextEstimateBase = {
  baseTokens: number;
  maxTokens: number;
  limit: number | null;
  providerId: string;
  modelId: string;
  recentEventCount: number;
  totalEventCount: number;
};

// Heavy part of the context estimate: serialize + tokenize up to
// CONTEXT_ESTIMATE_EVENT_LIMIT recent events. Split out so it only recomputes when
// the events/config/provider change — not on every composer keystroke.
function estimateContextBase({
  eventsResponse,
  configContent,
  selectedProviderId
}: {
  eventsResponse: SessionEventsResponse;
  configContent: string;
  selectedProviderId: string;
}): ContextEstimateBase {
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
  const baseShape = [
    "System prompt: local coding agent JSON tool protocol.",
    `Compressed context:\n${summaryText}`,
    `Recent event timeline:\n${recentEventText}`
  ].join("\n\n");
  const provider = splitProviderRecordId(selectedProviderId);
  return {
    baseTokens: estimateTokens(baseShape),
    maxTokens,
    limit,
    providerId: provider.providerId,
    modelId: provider.modelId,
    recentEventCount: estimatedEvents.length,
    totalEventCount: eventsResponse.events.length
  };
}

// Cheap part: only the draft prompt varies, so typing re-runs just this. Token
// counts are additive per character, so adding the prompt tokens to the cached base
// is equivalent to tokenizing the whole shape.
function estimateContextUsage(
  base: ContextEstimateBase,
  draftPrompt: string
): ContextUsage {
  const usedTokens =
    base.baseTokens + estimateTokens(`Current user prompt:\n${draftPrompt}`);
  const percent = Math.ceil((usedTokens / base.maxTokens) * 100);
  const limitIsDefault = !base.limit;

  return {
    percent,
    barPercent: Math.min(100, Math.max(0, percent)),
    usedTokens,
    maxTokens: base.maxTokens,
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
    providerId: base.providerId,
    model: base.modelId,
    limitIsDefault,
    notes: [
      appT("contextNotes.estimateSource", {
        recent: base.recentEventCount,
        total: base.totalEventCount
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

type ReasoningEffortSetting = ReasoningEffort | "";

type ProviderSettingsFields = {
  providerId: string;
  modelId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  supportsResponses: boolean;
  responsesSource: "model" | "provider" | "default";
  reasoningEffort: ReasoningEffortSetting;
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
    const modelOptions = asRecord(model.options);
    const modelProvider = asRecord(model.provider);
    const providerRequest = asRecord(provider.request);
    const modelRequest = asRecord(model.request);
    const modelApi = valueAsString(modelRequest.api);
    const providerApi = valueAsString(providerRequest.api);
    const responsesSource = modelApi
      ? "model"
      : providerApi
        ? "provider"
        : "default";
    const supportsResponses = (modelApi || providerApi) === "responses";
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
        valueAsString(options.key),
      supportsResponses,
      responsesSource,
      reasoningEffort: parseReasoningEffort(
        valueAsString(modelOptions.reasoningEffort)
      )
    };
  } catch {
    return {
      providerId: "",
      modelId: "",
      name: "",
      baseUrl: "",
      apiKey: "",
      supportsResponses: false,
      responsesSource: "default",
      reasoningEffort: ""
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

  const modelOptions = fields.reasoningEffort
    ? ensureRecord(model, "options")
    : asRecord(model.options);
  if (fields.reasoningEffort) {
    modelOptions.reasoningEffort = fields.reasoningEffort;
  } else if ("reasoningEffort" in modelOptions) {
    delete modelOptions.reasoningEffort;
  }
  if (Object.keys(modelOptions).length === 0 && "options" in model) {
    delete model.options;
  }

  const modelRequest = fields.supportsResponses
    ? ensureRecord(model, "request")
    : asRecord(model.request);
  const providerRequest = asRecord(provider.request);
  const providerApi = valueAsString(providerRequest.api);
  if (fields.supportsResponses) {
    modelRequest.api = "responses";
  } else if (providerApi === "responses") {
    modelRequest.api = "chatCompletions";
  } else if ("api" in modelRequest) {
    delete modelRequest.api;
  }
  if (Object.keys(modelRequest).length === 0 && "request" in model) {
    delete model.request;
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

function mcpServerFromImport(
  id: string,
  config: Record<string, unknown>
): McpServerConfig | null {
  const commandValue = config.command;
  let command = "";
  let args: string[] = [];
  if (Array.isArray(commandValue)) {
    const parts = commandValue.map((part) => String(part)).filter(Boolean);
    command = parts[0] ?? "";
    args = parts.slice(1);
  } else {
    command = valueAsString(commandValue);
    const rawArgs = config.args;
    args = Array.isArray(rawArgs) ? rawArgs.map((part) => String(part)).filter(Boolean) : [];
  }
  if (!command.trim()) {
    return null;
  }
  const envValue = asRecord(config.env);
  const environmentValue = asRecord(config.environment);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...environmentValue, ...envValue })) {
    env[key] = String(value);
  }
  const disabled = typeof config.disabled === "boolean" ? config.disabled : false;
  const enabled = disabled ? false : ((config.enabled as boolean | undefined) ?? true);
  return {
    id,
    enabled,
    command: command.trim(),
    args,
    env,
    cwd: valueAsString(config.cwd) || null,
    timeoutSeconds: mcpImportTimeoutSeconds(config),
    requireApproval: (config.requireApproval as boolean | undefined) ?? true,
    readOnly: (config.readOnly as boolean | undefined) ?? false
  };
}

function mcpImportTimeoutSeconds(config: Record<string, unknown>) {
  const raw =
    Number(config.timeoutSeconds) ||
    Number(config.timeout_seconds) ||
    Number(config.timeout) ||
    60;
  const seconds = raw > 600 ? Math.ceil(raw / 1000) : raw;
  return Math.max(1, Math.min(600, Math.floor(seconds)));
}

type SetupConfigFields = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelDisplayName: string;
  supportsResponses: boolean;
};

function generateSetupConfig(fields: SetupConfigFields): string {
  const rawId = fields.providerName.trim().toLowerCase().replace(/\s+/g, "-");
  const providerId = rawId || "openai-compatible";
  const modelId = fields.modelId.trim();
  const modelEntry: Record<string, unknown> = {
    name: fields.modelDisplayName.trim() || modelId
  };
  if (fields.supportsResponses) {
    modelEntry.request = { api: "responses" };
  }
  const providerEntry: Record<string, unknown> = {
    name: fields.providerName.trim() || providerId,
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: fields.baseUrl.trim() || "https://api.openai.com/v1",
      apiKey: fields.apiKey.trim()
    },
    models: {
      [modelId]: modelEntry
    }
  };
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${providerId}/${modelId}`,
    provider: {
      [providerId]: providerEntry
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
  supportsResponses: boolean;
};

const SETUP_PRESETS: SetupPreset[] = [
  {
    label: "OpenAI",
    providerName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4.1-mini",
    modelDisplayName: "GPT-4.1 Mini",
    supportsResponses: true
  },
  {
    label: "DeepSeek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
    modelDisplayName: "DeepSeek Chat",
    supportsResponses: false
  },
  {
    label: "SiliconFlow",
    providerName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    modelId: "deepseek-ai/DeepSeek-V3",
    modelDisplayName: "DeepSeek V3",
    supportsResponses: false
  },
  {
    label: "火山引擎",
    providerName: "Volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    modelId: "ark-code-latest",
    modelDisplayName: "ark-code-latest",
    supportsResponses: false
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
  const [supportsResponses, setSupportsResponses] = useState(false);
  const [formError, setFormError] = useState("");
  const [textImport, setTextImport] = useState("");
  const [textError, setTextError] = useState("");

  useEffect(() => {
    let disposed = false;
    findOpencodeConfig(projectRoot)
      .then((content) => {
        if (!disposed && content) setOpencodeContent(content);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [projectRoot]);

  function applyPreset(preset: SetupPreset) {
    setProviderName(preset.providerName);
    setBaseUrl(preset.baseUrl);
    setModelId(preset.modelId);
    setModelDisplayName(preset.modelDisplayName);
    setSupportsResponses(preset.supportsResponses);
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
      modelDisplayName,
      supportsResponses
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
                <ToggleSwitch
                  className="settingsWide"
                  label={t("setup.supportsResponses")}
                  checked={supportsResponses}
                  onChange={setSupportsResponses}
                />
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

function buildPromptInlineReferences(
  selectedPaths: Set<string>,
  attachments: PromptAttachment[],
  externalReferences: ExternalPromptReference[]
): PromptInlineReference[] {
  const selectedReferences = Array.from(selectedPaths)
    .sort()
    .map((path): PromptInlineReference => ({
      id: `path:${path}`,
      source: "selectedPath",
      sourceId: path,
      label: basename(path),
      detail: path,
      kind: "file"
    }));
  const attachmentReferences = attachments.map((attachment): PromptInlineReference => {
    const parsed = parseAttachmentReferenceLabel(attachment.name);
    return {
      id: `attachment:${attachment.id}`,
      source: "attachment",
      sourceId: attachment.id,
      label: parsed.label,
      detail: parsed.detail,
      kind: parsed.detail ? "selection" : "attachment"
    };
  });
  const externalPromptReferences = externalReferences.map((reference): PromptInlineReference => ({
    id: `external:${reference.id}`,
    source: "externalReference",
    sourceId: reference.id,
    label: externalPromptReferenceName(reference),
    detail: externalPromptReferenceLineLabel(reference, "display"),
    kind: externalPromptReferenceKind(reference)
  }));
  return [...selectedReferences, ...attachmentReferences, ...externalPromptReferences];
}

function parseAttachmentReferenceLabel(name: string) {
  const match = /^(.+):(\d+(?:-\d+)?)$/.exec(name);
  if (match) {
    return { label: match[1] ?? name, detail: match[2] ?? "" };
  }
  return { label: basename(name), detail: "" };
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
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
