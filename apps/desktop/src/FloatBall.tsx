import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AlertTriangle, Check, FolderOpen, KeyRound, Maximize2, Plus, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { OdodBotIcon, SleepingOdodBotIcon, WorkingOdodBotIcon } from "./OdodBotIcon";
import { appT } from "./i18n";
import {
  approveToolCall,
  cancelSession,
  continueSession,
  loadShellPolicy,
  promptSession,
  rejectToolCall,
  replyPermission,
  saveShellPolicy,
  type ExternalProjectSessionsPayload,
  type ExternalPromptReferencePayload
} from "./api";
import {
  clearExternalProjectSessions,
  EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY,
  readExternalProjectSessions
} from "./externalProjectSessions";
import { saveAppearanceMode } from "./appearanceMode";
import {
  appendPromptReferenceSections,
  externalPromptReferenceKind,
  externalPromptReferenceLineLabel,
  externalPromptReferenceName,
  externalPromptReferencesFromPayload,
  formatExternalPromptReferences,
  mergeExternalPromptReferences,
  PROMPT_REFERENCES_STORAGE_KEY,
  readPromptReferences,
  referencesEqual,
  resolvePromptReferencesFromStorage,
  savePromptReferences,
  type ExternalPromptReference
} from "./externalPromptReferences";
import {
  extractPromptEditorText,
  setPromptEditorText,
  syncPromptInlineReferences,
  type PromptInlineReference
} from "./promptInlineReferences";
import {
  COMPLETE_TO_IDLE_DELAY_MS,
  FLOAT_AGENT_STATUS_STORAGE_KEY,
  isStaleCompletedReply,
  saveFloatAgentStatus,
  loadFloatAgentStatus,
  type FloatAgentStatusRecord,
  type FloatAgentStatusKind
} from "./floatAgentStatus";
import {
  clipboardFiles,
  readPromptAttachment,
  shellAllowlistPrefix,
  toPromptAttachmentInput,
  type PromptAttachment
} from "./promptAttachments";
import {
  clearPromptDraft,
  PROMPT_DRAFT_STORAGE_KEY,
  readPromptDraft,
  savePromptDraft
} from "./promptDraft";

type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type FloatExpansionMode = "prompt" | "approval";
type FloatWindowLayoutKind = "ball" | "prompt" | "approval" | "reply" | "sessions";
type FloatWindowAnchor = { x: number; y: number };
type FloatWindowMetrics = {
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
};

const DRAG_THRESHOLD = 4;
const THEME_STORAGE_KEY = "odot.themeMode";
const COMPLETE_CHECK_DURATION_MS = 1_800;
const FLOAT_SLEEP_DELAY_MS = 30_000;
const FLOAT_BALL_WINDOW_SIZE = 72;
const FLOAT_BALL_CENTER = FLOAT_BALL_WINDOW_SIZE / 2;
const FLOAT_PROMPT_WIDTH = 332;
const FLOAT_PROMPT_INPUT_MIN_HEIGHT = 22;
const FLOAT_PROMPT_INPUT_MAX_HEIGHT = 116;
const FLOAT_PROMPT_CHROME_HEIGHT = 70;
const FLOAT_WINDOW_SCREEN_MARGIN = 8;
const FLOAT_APPROVAL_WIDTH = 332;
const FLOAT_APPROVAL_HEIGHT = 166;
const FLOAT_REPLY_WIDTH = 332;
const FLOAT_REPLY_HEIGHT = 136;
const FLOAT_REPLY_ANCHOR_OFFSET = 36;
const FLOAT_SESSIONS_WIDTH = 332;
const FLOAT_SESSIONS_HEADER_HEIGHT = 34;
const FLOAT_SESSIONS_OPTION_HEIGHT = 46;
const FLOAT_SESSIONS_MAX_HEIGHT = 320;

export function FloatBall() {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const [agentStatus, setAgentStatus] = useState(loadFloatAgentStatus);
  const [expandedMode, setExpandedMode] = useState<FloatExpansionMode | null>(null);
  const [promptText, setPromptText] = useState(() => readPromptDraft()?.text ?? "");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [externalPromptReferences, setExternalPromptReferences] = useState<
    ExternalPromptReference[]
  >(() => readPromptReferences()?.references ?? []);
  const [externalProjectSessions, setExternalProjectSessions] =
    useState<ExternalProjectSessionsPayload | null>(
      () => readExternalProjectSessions()?.payload ?? null
    );
  const promptReferencesDraftUpdatedAtRef = useRef(
    readPromptReferences()?.updatedAt ?? 0
  );
  const externalProjectSessionsUpdatedAtRef = useRef(
    readExternalProjectSessions()?.updatedAt ?? 0
  );
  const [panelError, setPanelError] = useState("");
  const [isSubmittingPrompt, setIsSubmittingPrompt] = useState(false);
  const [isResolvingApproval, setIsResolvingApproval] = useState(false);
  const [promptInputHeight, setPromptInputHeight] = useState(FLOAT_PROMPT_INPUT_MIN_HEIGHT);
  const [dismissedCompletedReply, setDismissedCompletedReply] = useState("");
  const [isSleeping, setIsSleeping] = useState(false);
  const [showCompleteCheck, setShowCompleteCheck] = useState(false);
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const completeCheckTimer = useRef<number | undefined>(undefined);
  const completeToIdleTimer = useRef<number | undefined>(undefined);
  const sleepTimer = useRef<number | undefined>(undefined);
  const cancelledErrorSession = useRef<string | undefined>(undefined);
  const pendingPromptStatus = useRef<{
    sessionId: string;
    previousMessage: string;
    startedAt: number;
  } | null>(null);
  const previousStatusKind = useRef<FloatAgentStatusKind>(agentStatus.kind);
  const promptDraftUpdatedAtRef = useRef(readPromptDraft()?.updatedAt ?? 0);
  const floatWindowAnchor = useRef<FloatWindowAnchor | null>(null);
  const promptInputRef = useRef<HTMLDivElement | null>(null);
  const resizeRequestId = useRef(0);
  const promptResizeFrame = useRef<number | undefined>(undefined);
  const promptResizeAttempts = useRef(0);
  const resizePromptInputRef = useRef<() => void>(() => {});

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let disposed = false;
    let unlistenTheme: (() => void) | undefined;

    function storedThemeMode(): ThemeMode {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      return stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
    }

    function applyResolvedTheme(theme: ResolvedTheme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }

    function syncTheme() {
      const mode = storedThemeMode();
      const resolvedTheme: ResolvedTheme =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
      applyResolvedTheme(resolvedTheme);
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        syncTheme();
      }
    };

    void listen<{ theme?: unknown }>("odot:theme-change", (event) => {
      const theme = event.payload.theme;
      if (theme === "light" || theme === "dark") {
        applyResolvedTheme(theme);
      } else {
        syncTheme();
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenTheme = unlisten;
    });

    syncTheme();
    window.addEventListener("storage", onStorage);
    media.addEventListener("change", syncTheme);

    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", syncTheme);
      unlistenTheme?.();
    };
  }, []);

  useEffect(() => {
    const applyExternalDraft = () => {
      const draft = readPromptDraft();
      if (!draft || draft.source === "float" || draft.updatedAt <= promptDraftUpdatedAtRef.current) {
        return;
      }
      promptDraftUpdatedAtRef.current = draft.updatedAt;
      setPromptText(draft.text);
      setPromptEditorText(promptInputRef.current, draft.text, floatPromptInlineReferences());
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
  }, []);

  useEffect(() => {
    savePromptReferences(externalPromptReferences, "float");
    promptReferencesDraftUpdatedAtRef.current = readPromptReferences()?.updatedAt ?? Date.now();
  }, [externalPromptReferences]);

  useEffect(() => {
    const applyExternalReferences = () => {
      setExternalPromptReferences((current) => {
        const nextReferences = resolvePromptReferencesFromStorage(
          "float",
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
    const syncFromStorage = () => {
      if (document.visibilityState === "visible") {
        applyExternalReferences();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", applyExternalReferences);
    document.addEventListener("visibilitychange", syncFromStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", applyExternalReferences);
      document.removeEventListener("visibilitychange", syncFromStorage);
    };
  }, []);

  useEffect(() => {
    const syncStatus = () => {
      const next = loadFloatAgentStatus();
      const pending = pendingPromptStatus.current;
      if (pending && next.sessionId === pending.sessionId) {
        const nextMessage = next.message?.trim() ?? "";
        if (
          next.updatedAt < pending.startedAt ||
          isStaleCompletedReply(nextMessage, pending.previousMessage)
        ) {
          return;
        }
        if (
          ((next.kind === "working" || next.kind === "thinking") && nextMessage) ||
          next.kind === "approval" ||
          next.kind === "error" ||
          (next.kind === "complete" && nextMessage)
        ) {
          pendingPromptStatus.current = null;
        }
      }
      setAgentStatus(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === FLOAT_AGENT_STATUS_STORAGE_KEY) {
        syncStatus();
      }
    };
    syncStatus();
    window.addEventListener("storage", onStorage);
    // Only poll while the float window is actually visible — the storage listener
    // still catches updates from other windows, so there is no need to burn a
    // wakeup every second while hidden. Resync immediately when we become visible.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        syncStatus();
      }
    }, 1000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        syncStatus();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, []);

  useLayoutEffect(() => {
    const editor = promptInputRef.current;
    if (!editor) {
      return;
    }
    syncPromptInlineReferences(editor, floatPromptInlineReferences());
    setPromptText(extractPromptEditorText(editor));
  }, [externalPromptReferences]);

  useEffect(() => {
    function enterFloatSleep() {
      setIsSleeping(true);
      if (sleepTimer.current) {
        window.clearTimeout(sleepTimer.current);
        sleepTimer.current = undefined;
      }
    }

    function syncFloatSleepWithVisibility() {
      if (document.visibilityState === "visible") {
        recordFloatMouseEvent();
      } else {
        enterFloatSleep();
      }
    }

    syncFloatSleepWithVisibility();
    document.addEventListener("visibilitychange", syncFloatSleepWithVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncFloatSleepWithVisibility);
      if (sleepTimer.current) {
        window.clearTimeout(sleepTimer.current);
        sleepTimer.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (promptResizeFrame.current) {
        window.cancelAnimationFrame(promptResizeFrame.current);
        promptResizeFrame.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    const previous = previousStatusKind.current;
    previousStatusKind.current = agentStatus.kind;
    const transitionedToComplete =
      previous !== "complete" && agentStatus.kind === "complete";
    if (transitionedToComplete) {
      recordFloatMouseEvent();
      setShowCompleteCheck(true);
      if (completeCheckTimer.current) {
        window.clearTimeout(completeCheckTimer.current);
      }
      completeCheckTimer.current = window.setTimeout(() => {
        setShowCompleteCheck(false);
        completeCheckTimer.current = undefined;
      }, COMPLETE_CHECK_DURATION_MS);
    } else if (agentStatus.kind !== "complete") {
      // 离开/被打断出「已完成」状态时必须显式复位：否则 <span> 不会卸载，
      // 下次 working→complete 时 setShowCompleteCheck(true) 是 no-op，CSS 动画无法重放。
      if (completeCheckTimer.current) {
        window.clearTimeout(completeCheckTimer.current);
        completeCheckTimer.current = undefined;
      }
      setShowCompleteCheck(false);
    }
    return () => {
      if (completeCheckTimer.current) {
        window.clearTimeout(completeCheckTimer.current);
        completeCheckTimer.current = undefined;
      }
    };
  }, [agentStatus.kind]);

  useEffect(() => {
    if (agentStatus.kind !== "complete") {
      setDismissedCompletedReply("");
    }
  }, [agentStatus.kind]);

  useEffect(() => {
    if (completeToIdleTimer.current) {
      window.clearTimeout(completeToIdleTimer.current);
      completeToIdleTimer.current = undefined;
    }
    if (agentStatus.kind !== "complete") {
      return;
    }
    const completedAt = agentStatus.completedAt ?? agentStatus.updatedAt;
    const remaining = COMPLETE_TO_IDLE_DELAY_MS - (Date.now() - completedAt);
    const transitionToIdle = () => {
      setAgentStatus((current) => {
        if (current.kind !== "complete") {
          return current;
        }
        return syncLocalStatus({
          kind: "idle",
          label: t("floatStatus.idle"),
          sessionId: current.sessionId,
          allowedAttachmentKinds: current.allowedAttachmentKinds,
          message: "",
          pendingApproval: null,
          completedAt: current.completedAt ?? current.updatedAt,
          updatedAt: Date.now()
        });
      });
    };
    if (remaining <= 0) {
      transitionToIdle();
      return;
    }
    completeToIdleTimer.current = window.setTimeout(() => {
      completeToIdleTimer.current = undefined;
      transitionToIdle();
    }, remaining);
    return () => {
      if (completeToIdleTimer.current) {
        window.clearTimeout(completeToIdleTimer.current);
        completeToIdleTimer.current = undefined;
      }
    };
  }, [
    agentStatus.completedAt,
    agentStatus.kind,
    agentStatus.sessionId,
    agentStatus.updatedAt,
    t
  ]);

  useEffect(() => {
    setExpandedMode((current) => {
      if (current === "approval" && agentStatus.kind !== "approval") {
        return null;
      }
      if (current === "prompt" && agentStatus.kind !== "idle" && agentStatus.kind !== "complete") {
        return null;
      }
      return current;
    });
  }, [agentStatus.kind]);

  useEffect(() => {
    if (agentStatus.kind !== "error" || !agentStatus.sessionId) {
      return;
    }
    if (cancelledErrorSession.current === agentStatus.sessionId) {
      return;
    }
    cancelledErrorSession.current = agentStatus.sessionId;
    void cancelSession(agentStatus.sessionId)
      .then(() => notifyMainSessionRefresh(agentStatus.sessionId))
      .catch(() => undefined);
  }, [agentStatus.kind, agentStatus.sessionId]);

  async function restoreMainWindow() {
    const floatWin = getCurrentWindow();
    const mainWin = await WebviewWindow.getByLabel("main");
    if (!mainWin) {
      setPanelError(t("error.unknown"));
      return;
    }
    const draftText = extractPromptEditorText(promptInputRef.current) || promptText;
    if (draftText.trim()) {
      savePromptDraft(draftText, "float");
      promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    }
    savePromptReferences(externalPromptReferences, "float");
    promptReferencesDraftUpdatedAtRef.current = readPromptReferences()?.updatedAt ?? Date.now();
    setExpandedMode(null);
    setPanelError("");
    try {
      saveAppearanceMode("window");
      await mainWin.show();
      await mainWin.setFocus();
      await floatWin.hide();
    } catch (error) {
      await floatWin.show().catch(() => undefined);
      await floatWin.setFocus().catch(() => undefined);
      setPanelError(errorSummary(error));
    }
  }

  function resetPointer(target: Element, pointerId: number) {
    if (target.hasPointerCapture?.(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
    pointerStart.current = null;
    setIsDragging(false);
  }

  function recordFloatMouseEvent() {
    setIsSleeping(false);
    if (sleepTimer.current) {
      window.clearTimeout(sleepTimer.current);
    }
    sleepTimer.current = window.setTimeout(() => {
      setIsSleeping(true);
    }, FLOAT_SLEEP_DELAY_MS);
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    recordFloatMouseEvent();
    if (event.button !== 0) {
      return;
    }
    pointerStart.current = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY
    };
    didDrag.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    recordFloatMouseEvent();
    const start = pointerStart.current;
    if (!start || start.id !== event.pointerId || didDrag.current) {
      return;
    }
    const dx = event.screenX - start.x;
    const dy = event.screenY - start.y;
    if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) {
      return;
    }
    didDrag.current = true;
    setIsDragging(true);
    resetPointer(event.currentTarget, event.pointerId);
    void invoke("start_float_drag")
      .finally(() => {
        setIsDragging(false);
      });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    recordFloatMouseEvent();
    const dragged = didDrag.current;
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
    if (dragged) {
      return;
    }
    if (agentStatus.kind === "approval" && agentStatus.pendingApproval) {
      if (expandedMode !== "approval") {
        setPanelError("");
        setExpandedMode("approval");
      }
      return;
    }
    if ((agentStatus.kind === "idle" || agentStatus.kind === "complete") && expandedMode !== "prompt") {
      openPromptPanel();
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    recordFloatMouseEvent();
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
  };

  function buildFloatPromptInlineReferences(
    references: ExternalPromptReference[] = externalPromptReferences
  ): PromptInlineReference[] {
    return references.map((reference): PromptInlineReference => ({
      id: `external:${reference.id}`,
      source: "externalReference",
      sourceId: reference.id,
      label: externalPromptReferenceName(reference),
      detail: externalPromptReferenceLineLabel(reference, "display"),
      kind: externalPromptReferenceKind(reference)
    }));
  }

  function openPromptPanel() {
    const draft = readPromptDraft();
    let nextPromptText = promptText;
    if (draft && draft.updatedAt >= promptDraftUpdatedAtRef.current) {
      promptDraftUpdatedAtRef.current = draft.updatedAt;
      nextPromptText = draft.text;
      setPromptText(nextPromptText);
    }
    const nextReferences = resolvePromptReferencesFromStorage(
      "float",
      promptReferencesDraftUpdatedAtRef,
      externalPromptReferences
    );
    if (!referencesEqual(externalPromptReferences, nextReferences)) {
      setExternalPromptReferences(nextReferences);
    }
    const inlineReferences = buildFloatPromptInlineReferences(nextReferences);
    setPromptInputHeight(FLOAT_PROMPT_INPUT_MIN_HEIGHT);
    promptResizeAttempts.current = 0;
    setExpandedMode("prompt");
    setPanelError("");
    window.setTimeout(() => {
      setPromptEditorText(promptInputRef.current, nextPromptText, inlineReferences);
      promptInputRef.current?.focus();
      schedulePromptInputResize();
    }, 0);
  }

  function closePromptPanel() {
    setExpandedMode(null);
    setPanelError("");
  }

  function selectExternalProjectSession(sessionId: string) {
    setAgentStatus((current) => syncLocalStatus({
      ...current,
      kind: "idle",
      label: t("floatStatus.idle"),
      sessionId,
      allowedAttachmentKinds: [],
      message: "",
      pendingApproval: null,
      completedAt: undefined
    }));
    setExternalProjectSessions(null);
    clearExternalProjectSessions("float");
    externalProjectSessionsUpdatedAtRef.current =
      readExternalProjectSessions()?.updatedAt ?? Date.now();
    setPanelError("");
    void emit("odot:float-select-session", { sessionId });
  }

  function requestExternalProjectSessionCreate(workspaceRoot: string) {
    const root = workspaceRoot.trim();
    if (!root) {
      return;
    }
    setExternalProjectSessions(null);
    clearExternalProjectSessions("float");
    externalProjectSessionsUpdatedAtRef.current =
      readExternalProjectSessions()?.updatedAt ?? Date.now();
    setPanelError("");
    void emit("odot:float-create-session", { workspaceRoot: root });
  }

  function floatPromptInlineReferences(): PromptInlineReference[] {
    return buildFloatPromptInlineReferences();
  }

  function handlePromptInput(event: FormEvent<HTMLDivElement>) {
    const value = extractPromptEditorText(event.currentTarget);
    setPromptText(value);
    savePromptDraft(value, "float");
    promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    pruneMissingPromptInlineReferences(event.currentTarget);
    schedulePromptInputResize();
  }

  function handlePromptEditorClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const removeButton = target.closest<HTMLButtonElement>("[data-remove-inline-reference]");
    if (!removeButton) {
      return;
    }
    event.preventDefault();
    const referenceId = removeButton.dataset.removeInlineReference;
    const reference = floatPromptInlineReferences().find((item) => item.id === referenceId);
    if (reference) {
      setExternalPromptReferences((current) =>
        current.filter((item) => item.id !== reference.sourceId)
      );
    }
  }

  function pruneMissingPromptInlineReferences(editor: HTMLDivElement) {
    const presentIds = new Set(
      Array.from(editor.querySelectorAll<HTMLElement>("[data-inline-reference-id]"))
        .map((node) => node.dataset.inlineReferenceId)
        .filter(Boolean)
    );
    for (const reference of floatPromptInlineReferences()) {
      if (presentIds.has(reference.id)) {
        continue;
      }
      setExternalPromptReferences((current) =>
        current.filter((item) => item.id !== reference.sourceId)
      );
    }
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    if (!agentStatus.allowedAttachmentKinds.length) {
      setPanelError(t("error.attachmentsUnsupported"));
      return;
    }
    try {
      const nextAttachments = await Promise.all(
        files.map((file) => readPromptAttachment(file, agentStatus.allowedAttachmentKinds))
      );
      setAttachments((current) => [...current, ...nextAttachments]);
      setPanelError("");
      schedulePromptInputResize();
    } catch (error) {
      setPanelError(errorSummary(error));
    }
  }

  function resizePromptInput() {
    if (!isPromptCapsuleOpen) {
      setPromptInputHeight(FLOAT_PROMPT_INPUT_MIN_HEIGHT);
      return;
    }
    const input = promptInputRef.current;
    if (!input) {
      return;
    }
    // The float window grows from ball width to prompt width asynchronously
    // (via Tauri IPC). Measuring while the window is still narrow makes the text
    // wrap into many lines, so the height gets wrongly clamped to the maximum.
    // Wait until the window has actually widened before measuring.
    if (
      window.innerWidth < FLOAT_PROMPT_WIDTH - 40 &&
      promptResizeAttempts.current < 60
    ) {
      promptResizeAttempts.current += 1;
      schedulePromptInputResize();
      return;
    }
    promptResizeAttempts.current = 0;
    const nextHeight = Math.min(
      FLOAT_PROMPT_INPUT_MAX_HEIGHT,
      promptInputContentHeight(input)
    );
    input.style.height = `${nextHeight}px`;
    setPromptInputHeight((current) => current === nextHeight ? current : nextHeight);
  }

  resizePromptInputRef.current = resizePromptInput;

  function schedulePromptInputResize() {
    if (promptResizeFrame.current) {
      window.cancelAnimationFrame(promptResizeFrame.current);
    }
    promptResizeFrame.current = window.requestAnimationFrame(() => {
      promptResizeFrame.current = undefined;
      resizePromptInputRef.current();
    });
  }

  async function sendPrompt() {
    const editorPrompt = extractPromptEditorText(promptInputRef.current, {
      includeReferences: true
    }).trim();
    const prompt = editorPrompt || promptText.trim();
    if (isSubmittingPrompt || (!prompt && !attachments.length && !externalPromptReferences.length)) {
      return;
    }
    if (!agentStatus.sessionId) {
      setPanelError(t("error.noCurrentSession"));
      return;
    }
    const nextAttachments = attachments;
    const nextExternalPromptReferences = externalPromptReferences;
    const previousMessage = agentStatus.message?.trim() ?? "";
    const externalReferenceText = formatExternalPromptReferences(nextExternalPromptReferences);
    const finalPrompt = appendPromptReferenceSections(
      prompt || t("prompt.continueFromAttachment"),
      [externalReferenceText]
    );
    setIsSubmittingPrompt(true);
    setPanelError("");
    setPromptText("");
    clearPromptDraft("float");
    promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    setAttachments([]);
    setExternalPromptReferences([]);
    setPromptEditorText(promptInputRef.current, "");
    closePromptPanel();
    pendingPromptStatus.current = {
      sessionId: agentStatus.sessionId,
      previousMessage,
      startedAt: Date.now()
    };
    setAgentStatus((current) => syncLocalStatus({
      ...current,
      kind: "working",
      label: t("float.agentWorking"),
      message: "",
      pendingApproval: null,
      completedAt: undefined
    }));
    try {
      await promptSession({
        sessionId: agentStatus.sessionId,
        prompt: finalPrompt,
        attachments: nextAttachments.map(toPromptAttachmentInput),
        delivery: "queue",
        resume: true
      });
      await notifyMainSessionRefresh(agentStatus.sessionId);
    } catch (error) {
      setPanelError(errorSummary(error));
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: "error",
        label: t("float.agentError")
      }));
    } finally {
      setIsSubmittingPrompt(false);
    }
  }

  async function resolveApproval(action: "approve" | "allow" | "reject") {
    const pending = agentStatus.pendingApproval;
    if (!pending || isResolvingApproval) {
      return;
    }
    setIsResolvingApproval(true);
    setPanelError("");
    try {
      if (pending.kind === "permission") {
        await replyPermission({
          requestId: pending.eventId,
          reply: action === "allow" ? "always" : action === "reject" ? "reject" : "once"
        });
      } else if (action === "allow") {
        const policy = await loadShellPolicy();
        const prefix = shellAllowlistPrefix(pending.command);
        if (prefix) {
          await saveShellPolicy({
            autoAllowlist: Array.from(new Set([...policy.autoAllowlist, prefix]))
          });
        }
      }
      if (pending.kind === "tool") {
        if (action === "reject") {
          await rejectToolCall(pending.eventId);
        } else {
          await approveToolCall(pending.eventId);
        }
      }
      if (action !== "reject") {
        if (agentStatus.sessionId) {
          await continueSession(agentStatus.sessionId);
        }
      }
      if (agentStatus.sessionId) {
        await notifyMainSessionRefresh(agentStatus.sessionId);
      }
      setExpandedMode(null);
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: action === "reject" ? "idle" : "working",
        label: action === "reject" ? t("float.commandRejected") : t("float.agentWorking"),
        message: "",
        pendingApproval: null
      }));
    } catch (error) {
      setPanelError(errorSummary(error));
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: "error",
        label: t("float.agentError")
      }));
    } finally {
      setIsResolvingApproval(false);
    }
  }

  const canOpenPrompt = agentStatus.kind === "idle" || agentStatus.kind === "complete";
  const isAgentActive = agentStatus.kind === "working" || agentStatus.kind === "thinking";
  const rawAgentMessage = agentStatus.message?.trim() ?? "";
  const displayAgentMessage =
    isAgentActive &&
    pendingPromptStatus.current?.sessionId === agentStatus.sessionId &&
    isStaleCompletedReply(rawAgentMessage, pendingPromptStatus.current.previousMessage)
      ? ""
      : rawAgentMessage;
  const completedReplyKey = [
    agentStatus.sessionId,
    rawAgentMessage
  ].join(":");
  const hasCompletedReply =
    agentStatus.kind === "complete" &&
    Boolean(rawAgentMessage) &&
    dismissedCompletedReply !== completedReplyKey;
  const isApprovalPending = agentStatus.kind === "approval";
  const isError = agentStatus.kind === "error";
  const showSleepingIcon =
    isSleeping &&
    !isAgentActive &&
    !hasCompletedReply &&
    !isApprovalPending &&
    !isError &&
    !showCompleteCheck;
  const liveMessage = (hasCompletedReply ? rawAgentMessage : displayAgentMessage) || agentStatus.label;
  const isPromptCapsuleOpen = expandedMode === "prompt" && canOpenPrompt;
  const isApprovalCapsuleOpen =
    expandedMode === "approval" && isApprovalPending && Boolean(agentStatus.pendingApproval);
  const externalProjectSessionCount = externalProjectSessions?.sessions.length ?? 0;
  const externalProjectWorkspaceRoot = externalProjectSessions?.workspaceRoot?.trim() ?? "";
  const showSessionsCapsule =
    !isPromptCapsuleOpen &&
    !isApprovalCapsuleOpen &&
    Boolean(externalProjectSessionCount || externalProjectWorkspaceRoot);
  const showReplyCapsule =
    !isPromptCapsuleOpen &&
    !isApprovalCapsuleOpen &&
    !showSessionsCapsule &&
    (hasCompletedReply || (isAgentActive && displayAgentMessage.length > 0)) &&
    liveMessage.length > 0;
  const shouldRenderMarkdown =
    (agentStatus.kind === "working" && displayAgentMessage.length > 0) || hasCompletedReply;
  const canSendPrompt =
    Boolean(promptText.trim() || attachments.length || externalPromptReferences.length) &&
    !isSubmittingPrompt;

  useLayoutEffect(() => {
    if (!isPromptCapsuleOpen) {
      return;
    }
    const nextReferences = resolvePromptReferencesFromStorage(
      "float",
      promptReferencesDraftUpdatedAtRef,
      externalPromptReferences
    );
    if (!referencesEqual(externalPromptReferences, nextReferences)) {
      setExternalPromptReferences(nextReferences);
    }
    setPromptEditorText(
      promptInputRef.current,
      promptText,
      buildFloatPromptInlineReferences(nextReferences)
    );
  }, [externalPromptReferences, isPromptCapsuleOpen, promptText]);

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
        if (!canOpenPrompt || isSubmittingPrompt) {
          setPanelError(t("prompt.agentWorking"));
          return;
        }
        const nextReferences = externalPromptReferencesFromPayload(payload);
        if (!nextReferences.length) {
          setPanelError(t("error.unknown"));
          return;
        }
        setExternalPromptReferences((current) =>
          mergeExternalPromptReferences(current, nextReferences)
        );
        setPanelError("");
        setExpandedMode("prompt");
        window.setTimeout(() => promptInputRef.current?.focus(), 0);
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
  }, [canOpenPrompt, isSubmittingPrompt, t]);

  useEffect(() => {
    const applyExternalProjectSessions = () => {
      const draft = readExternalProjectSessions();
      if (
        !draft ||
        draft.source === "float" ||
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

  const promptInputChromeHeight =
    FLOAT_PROMPT_CHROME_HEIGHT +
    (attachments.length ? 32 : 0) +
    (panelError ? 20 : 0);
  const promptWindowHeight = promptInputChromeHeight + promptInputHeight;

  useLayoutEffect(() => {
    resizePromptInput();
  }, [externalPromptReferences.length, isPromptCapsuleOpen, promptText]);

  const sessionsCapsuleOptionCount =
    externalProjectSessionCount + (externalProjectWorkspaceRoot ? 1 : 0);
  const sessionsCapsuleHeight = Math.min(
    FLOAT_SESSIONS_HEADER_HEIGHT +
      12 +
      sessionsCapsuleOptionCount * FLOAT_SESSIONS_OPTION_HEIGHT,
    FLOAT_SESSIONS_MAX_HEIGHT
  );
  const floatLayoutKind: FloatWindowLayoutKind = isPromptCapsuleOpen
    ? "prompt"
    : isApprovalCapsuleOpen
      ? "approval"
      : showSessionsCapsule
        ? "sessions"
        : showReplyCapsule
          ? "reply"
          : "ball";
  const floatWindowMetrics = floatWindowLayoutMetrics(
    floatLayoutKind,
    promptWindowHeight,
    sessionsCapsuleHeight
  );
  const containerClassName = [
    "floatBallContainer",
    floatLayoutKind !== "ball" ? "floatBallContainer--expanded" : "",
    isAgentActive ? "floatBallContainer--active" : "",
    isApprovalPending ? "floatBallContainer--approval" : "",
    isError ? "floatBallContainer--error" : ""
  ].filter(Boolean).join(" ");
  const floatBallClassName = [
    "floatBall",
    isDragging ? "floatBall--dragging" : "",
    showSleepingIcon ? "floatBall--sleeping" : "",
    isAgentActive ? "floatBall--working" : "",
    isApprovalPending ? "floatBall--approval" : "",
    isError ? "floatBall--error" : "",
    showCompleteCheck ? "floatBall--complete" : "",
    floatLayoutKind !== "ball" ? "floatBall--inCapsule" : ""
  ].filter(Boolean).join(" ");
  const capsuleClassName = [
    "floatCapsule",
    floatLayoutKind !== "ball" ? "floatCapsule--expanded" : "",
    isPromptCapsuleOpen ? "floatCapsule--prompt" : "",
    isApprovalCapsuleOpen ? "floatCapsule--approval" : "",
    showSessionsCapsule ? "floatCapsule--sessions" : "",
    showReplyCapsule ? "floatCapsule--reply" : "",
  ].filter(Boolean).join(" ");
  const approvalTitle = agentStatus.pendingApproval?.command.trim();

  useEffect(() => {
    const requestId = ++resizeRequestId.current;
    void resizeFloatWindow(
      floatWindowMetrics,
      floatWindowAnchor,
      () => requestId === resizeRequestId.current
    ).catch(() => undefined);
  }, [
    floatWindowMetrics.anchorX,
    floatWindowMetrics.anchorY,
    floatWindowMetrics.height,
    floatWindowMetrics.width
  ]);

  return (
    <div className={containerClassName}>
      <section className={capsuleClassName}>

      <button
        type="button"
        className={floatBallClassName}
        onPointerDown={(event) => {
          handlePointerDown(event);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={recordFloatMouseEvent}
        title={approvalTitle || agentStatus.label}
      >
        {isError ? (
          <AlertTriangle size={27} strokeWidth={2.3} />
        ) : isApprovalPending ? (
          <KeyRound size={28} strokeWidth={2.3} />
        ) : isAgentActive ? (
          <WorkingOdodBotIcon size={28} strokeWidth={2.3} />
        ) : showSleepingIcon ? (
          <SleepingOdodBotIcon size={28} strokeWidth={2.3} />
        ) : (
          <OdodBotIcon size={28} strokeWidth={2.3} />
        )}
        {showCompleteCheck && (
          <span className="floatBallCheckBurst" aria-hidden="true">
            <Check size={24} strokeWidth={3.2} />
          </span>
        )}
      </button>

      {showReplyCapsule && (
        <div className="floatCapsulePanel floatReplyCapsule" aria-live="polite">
          <div className="floatReplyHeader">
            <span>{agentStatus.label}</span>
            <span className="floatReplyHeaderActions">
              {hasCompletedReply && (
                <button
                  type="button"
                  className="floatPanelIconButton"
                  aria-label={t("prompt.closePanel")}
                  title={t("prompt.closePanel")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDismissedCompletedReply(completedReplyKey);
                  }}
                >
                  <X size={13} />
                </button>
              )}
              <button
                type="button"
                className="floatPanelIconButton floatWindowModeButton"
                aria-label={t("common.expand")}
                title={t("common.expand")}
                onClick={(event) => {
                  event.stopPropagation();
                  void restoreMainWindow();
                }}
              >
                <Maximize2 size={13} />
              </button>
            </span>
          </div>
          <div
            className={`floatReplyTextStream ${hasCompletedReply ? "floatReplyTextStream--complete" : ""}`}
            key={liveMessage}
          >
            {shouldRenderMarkdown ? (
              <div className="floatThinkingBubbleMarkdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children, ...props }) => (
                      <div className="floatMarkdownTableScroll">
                        <table {...props}>{children}</table>
                      </div>
                    )
                  }}
                >
                  {liveMessage}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="floatThinkingBubbleText">{liveMessage}</p>
            )}
          </div>
        </div>
      )}

      {showSessionsCapsule && (
        <div className="floatCapsulePanel floatSessionsCapsule" aria-live="polite">
          <div className="floatSessionsHeader">
            <span>
              <FolderOpen size={12} />
              {t("externalProjectSessions.title")}
            </span>
            <button
              type="button"
              className="floatPanelIconButton"
              aria-label={t("externalProjectSessions.dismiss")}
              onClick={(event) => {
                event.stopPropagation();
                setExternalProjectSessions(null);
                clearExternalProjectSessions("float");
                externalProjectSessionsUpdatedAtRef.current =
                  readExternalProjectSessions()?.updatedAt ?? Date.now();
              }}
            >
              <X size={12} />
            </button>
          </div>
          {(externalProjectSessions?.action === "deferredBusy" ||
            externalProjectSessions?.action === "error") && (
            <div className="floatSessionsWarning">
              {externalProjectSessions.busyReason ??
                t("externalProjectSessions.busyReason")}
            </div>
          )}
          <div className="floatSessionsList">
            {externalProjectSessions?.sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className="floatSessionsOption"
                onClick={(event) => {
                  event.stopPropagation();
                  selectExternalProjectSession(session.id);
                }}
              >
                <span>{session.title}</span>
                <small>{appT(`mode.${session.mode}`)} / {session.status}</small>
              </button>
            ))}
            {externalProjectWorkspaceRoot ? (
              <button
                type="button"
                className="floatSessionsOption floatSessionsOption--create"
                onClick={(event) => {
                  event.stopPropagation();
                  requestExternalProjectSessionCreate(externalProjectWorkspaceRoot);
                }}
              >
                <span>
                  <Plus size={12} />
                  {t("externalProjectSessions.create")}
                </span>
                <small>{externalProjectWorkspaceRoot}</small>
              </button>
            ) : null}
          </div>
        </div>
      )}

      {isPromptCapsuleOpen && (
        <form
          className="floatCapsulePanel floatPromptCapsule"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt();
          }}
        >
          <div
            ref={promptInputRef}
            className={`floatPromptInput promptRichInput ${
              !promptText.trim() && !externalPromptReferences.length ? "empty" : ""
            }`}
            role="textbox"
            aria-label={t("prompt.placeholder")}
            data-placeholder={t("prompt.placeholder")}
            contentEditable={!isSubmittingPrompt}
            suppressContentEditableWarning
            onInput={handlePromptInput}
            onClick={handlePromptEditorClick}
            onPaste={(event) => void handlePaste(event)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendPrompt();
              } else if (event.key === "Enter" && event.shiftKey) {
                schedulePromptInputResize();
              }
            }}
          />
          {attachments.length > 0 && (
            <div className="floatAttachmentList">
              {attachments.map((attachment) => (
                <span className="floatAttachmentChip" key={attachment.id}>
                  {attachment.kind === "image" ? t("common.image") : t("common.text")} · {formatBytes(attachment.size)}
                  <button
                    type="button"
                    aria-label={t("nav.removeAttachment", { name: attachment.name })}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id)
                      )
                    }
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {panelError && <div className="floatPanelError">{panelError}</div>}
          <div className="floatPromptFooter">
            <span>{isSubmittingPrompt ? t("common.sending") : t("prompt.pasteAttachments")}</span>
            <button
              type="button"
              className="floatPanelIconButton floatWindowModeButton"
              aria-label={t("common.expand")}
              title={t("common.expand")}
              onClick={(event) => {
                event.stopPropagation();
                void restoreMainWindow();
              }}
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              className="floatPanelIconButton"
              aria-label={t("prompt.closePanel")}
              title={t("prompt.closePanel")}
              onClick={closePromptPanel}
            >
              <X size={13} />
            </button>
            <button
              type="submit"
              className="floatPrimaryButton"
              disabled={!canSendPrompt}
            >
              <Send size={13} />
              {t("common.send")}
            </button>
          </div>
        </form>
      )}

      {isApprovalCapsuleOpen && agentStatus.pendingApproval && (
        <section
          className="floatCapsulePanel floatApprovalCapsule"
        >
          <span className="floatApprovalTitle">{t("prompt.waitingApproval")}</span>
          <code className="floatCommandPreview">
            {agentStatus.pendingApproval.command}
          </code>
          {panelError && <div className="floatPanelError">{panelError}</div>}
          <div className="floatApprovalActions">
            <button
              type="button"
              className="floatPanelIconButton floatWindowModeButton floatWindowModeButton--approval"
              aria-label={t("common.expand")}
              title={t("common.expand")}
              onClick={(event) => {
                event.stopPropagation();
                void restoreMainWindow();
              }}
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              className="floatDecisionButton floatDecisionButton--approve"
              aria-label={t("common.approve")}
              title={t("common.approve")}
              disabled={isResolvingApproval}
              onClick={(event) => {
                event.stopPropagation();
                void resolveApproval("approve");
              }}
            >
              <Check size={15} />
            </button>
            <button
              type="button"
              className="floatDecisionButton floatDecisionButton--reject"
              aria-label={t("common.reject")}
              title={t("common.reject")}
              disabled={isResolvingApproval}
              onClick={(event) => {
                event.stopPropagation();
                void resolveApproval("reject");
              }}
            >
              <X size={15} />
            </button>
            <button
              type="button"
              className="floatDecisionButton floatDecisionButton--allow"
              aria-label={t("common.addToAllowlist")}
              title={t("common.addToAllowlist")}
              disabled={isResolvingApproval}
              onClick={(event) => {
                event.stopPropagation();
                void resolveApproval("allow");
              }}
            >
              <ShieldCheck size={15} />
            </button>
          </div>
        </section>
      )}
      </section>
    </div>
  );
}

function floatWindowLayoutMetrics(
  kind: FloatWindowLayoutKind,
  promptHeight: number,
  sessionsHeight = 0
): FloatWindowMetrics {
  if (kind === "sessions") {
    return {
      width: FLOAT_SESSIONS_WIDTH,
      height: sessionsHeight,
      anchorX: FLOAT_SESSIONS_WIDTH / 2,
      anchorY: sessionsHeight / 2
    };
  }
  if (kind === "prompt") {
    return {
      width: FLOAT_PROMPT_WIDTH,
      height: promptHeight,
      anchorX: FLOAT_PROMPT_WIDTH / 2,
      anchorY: promptHeight / 2
    };
  }
  if (kind === "approval") {
    return {
      width: FLOAT_APPROVAL_WIDTH,
      height: FLOAT_APPROVAL_HEIGHT,
      anchorX: FLOAT_APPROVAL_WIDTH / 2,
      anchorY: FLOAT_APPROVAL_HEIGHT / 2
    };
  }
  if (kind === "reply") {
    return {
      width: FLOAT_REPLY_WIDTH,
      height: FLOAT_REPLY_HEIGHT,
      anchorX: FLOAT_REPLY_ANCHOR_OFFSET,
      anchorY: FLOAT_REPLY_HEIGHT / 2
    };
  }
  return {
    width: FLOAT_BALL_WINDOW_SIZE,
    height: FLOAT_BALL_WINDOW_SIZE,
    anchorX: FLOAT_BALL_CENTER,
    anchorY: FLOAT_BALL_CENTER
  };
}

function promptInputContentHeight(input: HTMLDivElement) {
  const style = window.getComputedStyle(input);
  const lineHeight = cssPixels(style.lineHeight)
    ?? (cssPixels(style.fontSize) ?? 12) * 1.45;
  const paddingTop = cssPixels(style.paddingTop) ?? 0;
  const paddingBottom = cssPixels(style.paddingBottom) ?? 0;
  if (!input.textContent?.trim() && !input.querySelector("[data-inline-reference-id]")) {
    return FLOAT_PROMPT_INPUT_MIN_HEIGHT;
  }
  // Temporarily set height:auto + overflow:hidden so scrollHeight
  // returns the true content height instead of the previously set
  // fixed height (WebView2 may return the fixed height otherwise).
  const savedHeight = input.style.height;
  const savedOverflow = input.style.overflowY;
  input.style.height = "auto";
  input.style.overflowY = "hidden";
  const naturalHeight = input.scrollHeight;
  input.style.height = savedHeight;
  input.style.overflowY = savedOverflow;
  const singleLineHeight = Math.ceil(lineHeight + paddingTop + paddingBottom);
  return Math.max(FLOAT_PROMPT_INPUT_MIN_HEIGHT, naturalHeight, singleLineHeight);
}

function cssPixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function resizeFloatWindow(
  metrics: FloatWindowMetrics,
  anchorRef: { current: FloatWindowAnchor | null },
  isCurrent: () => boolean = () => true
) {
  const floatWin = getCurrentWindow();
  const scaleFactor = window.devicePixelRatio || 1;
  const [position, size] = await Promise.all([
    floatWin.outerPosition(),
    floatWin.outerSize()
  ]);
  const monitor = await currentMonitor();
  if (!isCurrent()) {
    return;
  }
  const currentAnchor = anchorRef.current ?? {
    x: size.width / scaleFactor / 2,
    y: size.height / scaleFactor / 2
  };
  const anchorX = position.x + currentAnchor.x * scaleFactor;
  const anchorY = position.y + currentAnchor.y * scaleFactor;
  const nextX = Math.round(anchorX - metrics.anchorX * scaleFactor);
  const nextY = Math.round(anchorY - metrics.anchorY * scaleFactor);
  const nextPosition = clampFloatWindowPosition(nextX, nextY, metrics, scaleFactor, monitor);

  await floatWin.setSize(new LogicalSize(metrics.width, metrics.height));
  if (!isCurrent()) {
    return;
  }
  await floatWin.setPosition(new PhysicalPosition(nextPosition.x, nextPosition.y));
  if (!isCurrent()) {
    return;
  }
  anchorRef.current = {
    x: metrics.anchorX,
    y: metrics.anchorY
  };
}

function clampFloatWindowPosition(
  x: number,
  y: number,
  metrics: FloatWindowMetrics,
  scaleFactor: number,
  monitor: Awaited<ReturnType<typeof currentMonitor>>
) {
  if (!monitor) {
    return { x, y };
  }

  const margin = FLOAT_WINDOW_SCREEN_MARGIN * scaleFactor;
  const left = monitor.workArea.position.x + margin;
  const top = monitor.workArea.position.y + margin;
  const right = monitor.workArea.position.x + monitor.workArea.size.width - margin;
  const bottom = monitor.workArea.position.y + monitor.workArea.size.height - margin;
  const width = metrics.width * scaleFactor;
  const height = metrics.height * scaleFactor;
  const maxX = Math.max(left, right - width);
  const maxY = Math.max(top, bottom - height);

  return {
    x: Math.round(clampNumber(x, left, maxX)),
    y: Math.round(clampNumber(y, top, maxY))
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function notifyMainSessionRefresh(sessionId: string) {
  await emit("odot:float-session-refresh", { sessionId });
}

function syncLocalStatus(status: FloatAgentStatusRecord) {
  const next = {
    ...status,
    updatedAt: Date.now()
  };
  saveFloatAgentStatus(next);
  return next;
}

function errorSummary(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return appT("error.operationFailed");
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
