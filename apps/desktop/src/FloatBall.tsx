import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AlertTriangle, Check, KeyRound, Maximize2, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent } from "react";
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
  saveShellPolicy
} from "./api";
import {
  FLOAT_AGENT_STATUS_STORAGE_KEY,
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
type SideBubbleDirection = "right" | "left";
type FloatExpansionMode = "prompt" | "approval";
type FloatWindowLayoutKind = "ball" | "prompt" | "approval" | "reply";
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
const FLOAT_REPLY_HEIGHT = 112;
const FLOAT_REPLY_ANCHOR_OFFSET = 36;
let promptTextMeasureContext: CanvasRenderingContext2D | null | undefined;

export function FloatBall() {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const [agentStatus, setAgentStatus] = useState(loadFloatAgentStatus);
  const [expandedMode, setExpandedMode] = useState<FloatExpansionMode | null>(null);
  const [promptText, setPromptText] = useState(() => readPromptDraft()?.text ?? "");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [panelError, setPanelError] = useState("");
  const [isSubmittingPrompt, setIsSubmittingPrompt] = useState(false);
  const [isResolvingApproval, setIsResolvingApproval] = useState(false);
  const [promptInputHeight, setPromptInputHeight] = useState(FLOAT_PROMPT_INPUT_MIN_HEIGHT);
  const [isSleeping, setIsSleeping] = useState(false);
  const [showCompleteCheck, setShowCompleteCheck] = useState(false);
  const [thinkingBubbleDirection, setThinkingBubbleDirection] =
    useState<SideBubbleDirection>("right");
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const completeCheckTimer = useRef<number | undefined>(undefined);
  const sleepTimer = useRef<number | undefined>(undefined);
  const cancelledErrorSession = useRef<string | undefined>(undefined);
  const previousStatusKind = useRef<FloatAgentStatusKind>(agentStatus.kind);
  const promptDraftUpdatedAtRef = useRef(readPromptDraft()?.updatedAt ?? 0);
  const floatWindowAnchor = useRef<FloatWindowAnchor | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeRequestId = useRef(0);

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
    const syncStatus = () => setAgentStatus(loadFloatAgentStatus());
    const onStorage = (event: StorageEvent) => {
      if (event.key === FLOAT_AGENT_STATUS_STORAGE_KEY) {
        syncStatus();
      }
    };
    syncStatus();
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(syncStatus, 1000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, []);

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
    if (agentStatus.kind === "working" || agentStatus.kind === "thinking") {
      void resolveSideBubbleDirection().then(setThinkingBubbleDirection);
    }
  }, [agentStatus.kind]);

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
    await mainWin?.show();
    await mainWin?.setFocus();
    await floatWin.hide();
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
        void resolveSideBubbleDirection().then(setThinkingBubbleDirection);
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

  function openPromptPanel() {
    const draft = readPromptDraft();
    if (draft && draft.updatedAt >= promptDraftUpdatedAtRef.current) {
      promptDraftUpdatedAtRef.current = draft.updatedAt;
      setPromptText(draft.text);
    }
    setPromptInputHeight(FLOAT_PROMPT_INPUT_MIN_HEIGHT);
    setExpandedMode("prompt");
    setPanelError("");
  }

  function closePromptPanel() {
    setExpandedMode(null);
    setPanelError("");
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
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
    } catch (error) {
      setPanelError(errorSummary(error));
    }
  }

  async function sendPrompt() {
    const prompt = promptText.trim();
    if (isSubmittingPrompt || (!prompt && !attachments.length)) {
      return;
    }
    if (!agentStatus.sessionId) {
      setPanelError(t("error.noCurrentSession"));
      return;
    }
    const nextAttachments = attachments;
    setIsSubmittingPrompt(true);
    setPanelError("");
    setPromptText("");
    clearPromptDraft("float");
    promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
    setAttachments([]);
    closePromptPanel();
    setAgentStatus((current) => syncLocalStatus({
      ...current,
      kind: "working",
      label: t("float.agentWorking"),
      message: "",
      pendingApproval: null
    }));
    try {
      await promptSession({
        sessionId: agentStatus.sessionId,
        prompt: prompt || t("prompt.continueFromAttachment"),
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
  const isApprovalPending = agentStatus.kind === "approval";
  const isError = agentStatus.kind === "error";
  const showSleepingIcon =
    isSleeping && !isAgentActive && !isApprovalPending && !isError && !showCompleteCheck;
  const liveMessage = agentStatus.message?.trim() || agentStatus.label;
  const isPromptCapsuleOpen = expandedMode === "prompt" && canOpenPrompt;
  const isApprovalCapsuleOpen =
    expandedMode === "approval" && isApprovalPending && Boolean(agentStatus.pendingApproval);
  const showReplyCapsule =
    !isPromptCapsuleOpen && !isApprovalCapsuleOpen && isAgentActive && liveMessage.length > 0;
  const shouldRenderMarkdown = agentStatus.kind === "working";
  const canSendPrompt =
    Boolean(promptText.trim() || attachments.length) &&
    Boolean(agentStatus.sessionId) &&
    !isSubmittingPrompt;
  const promptInputChromeHeight =
    FLOAT_PROMPT_CHROME_HEIGHT +
    (attachments.length ? 32 : 0) +
    (panelError ? 20 : 0);
  const promptWindowHeight = promptInputChromeHeight + promptInputHeight;

  useLayoutEffect(() => {
    if (!isPromptCapsuleOpen) {
      setPromptInputHeight(FLOAT_PROMPT_INPUT_MIN_HEIGHT);
      return;
    }
    const input = promptInputRef.current;
    if (!input) {
      return;
    }
    const nextHeight = Math.min(
      FLOAT_PROMPT_INPUT_MAX_HEIGHT,
      promptInputContentHeight(input, input.value)
    );
    input.style.height = `${nextHeight}px`;
    setPromptInputHeight((current) => current === nextHeight ? current : nextHeight);
  }, [isPromptCapsuleOpen, promptText]);

  const floatLayoutKind: FloatWindowLayoutKind = isPromptCapsuleOpen
    ? "prompt"
    : isApprovalCapsuleOpen
      ? "approval"
      : showReplyCapsule
        ? "reply"
        : "ball";
  const floatWindowMetrics = floatWindowLayoutMetrics(
    floatLayoutKind,
    thinkingBubbleDirection,
    promptWindowHeight
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
    showReplyCapsule ? "floatCapsule--reply" : "",
    showReplyCapsule ? `floatCapsule--${thinkingBubbleDirection}` : ""
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
          </div>
          <div className="floatReplyTextStream" key={liveMessage}>
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
          <textarea
            ref={promptInputRef}
            className="floatPromptInput"
            value={promptText}
            placeholder={t("prompt.placeholder")}
            disabled={isSubmittingPrompt}
            onChange={(event) => {
              const value = event.target.value;
              setPromptText(value);
              savePromptDraft(value, "float");
              promptDraftUpdatedAtRef.current = readPromptDraft()?.updatedAt ?? Date.now();
            }}
            onPaste={(event) => void handlePaste(event)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendPrompt();
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
  direction: SideBubbleDirection,
  promptHeight: number
): FloatWindowMetrics {
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
      anchorX: direction === "left"
        ? FLOAT_REPLY_WIDTH - FLOAT_REPLY_ANCHOR_OFFSET
        : FLOAT_REPLY_ANCHOR_OFFSET,
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

function promptInputContentHeight(input: HTMLTextAreaElement, value: string) {
  const text = value.trimEnd();
  if (!text) {
    return FLOAT_PROMPT_INPUT_MIN_HEIGHT;
  }

  const style = window.getComputedStyle(input);
  const lineHeight = cssPixels(style.lineHeight)
    ?? (cssPixels(style.fontSize) ?? 12) * 1.45;
  const paddingTop = cssPixels(style.paddingTop) ?? 0;
  const paddingBottom = cssPixels(style.paddingBottom) ?? 0;
  const paddingLeft = cssPixels(style.paddingLeft) ?? 0;
  const paddingRight = cssPixels(style.paddingRight) ?? 0;
  const inputWidth =
    input.clientWidth ||
    input.getBoundingClientRect().width ||
    FLOAT_PROMPT_WIDTH - 74;
  const contentWidth = Math.max(1, inputWidth - paddingLeft - paddingRight);
  const rows = promptInputWrappedRows(
    text,
    style.font || `${style.fontSize} ${style.fontFamily}`,
    contentWidth
  );

  return Math.max(
    FLOAT_PROMPT_INPUT_MIN_HEIGHT,
    Math.ceil(rows * lineHeight + paddingTop + paddingBottom)
  );
}

function promptInputWrappedRows(text: string, font: string, width: number) {
  const context = promptMeasureContext();
  if (!context) {
    return Math.max(1, text.split(/\r?\n/).length);
  }

  context.font = font;
  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      rows += 1;
      continue;
    }

    let lineRows = 1;
    let currentWidth = 0;
    for (const char of Array.from(line)) {
      const charWidth = context.measureText(char).width;
      if (currentWidth > 0 && currentWidth + charWidth > width) {
        lineRows += 1;
        currentWidth = charWidth;
      } else {
        currentWidth += charWidth;
      }
    }
    rows += lineRows;
  }

  return Math.max(1, rows);
}

function promptMeasureContext() {
  if (promptTextMeasureContext !== undefined) {
    return promptTextMeasureContext;
  }
  promptTextMeasureContext = document.createElement("canvas").getContext("2d");
  return promptTextMeasureContext;
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

async function resolveSideBubbleDirection(): Promise<SideBubbleDirection> {
  try {
    const floatWin = getCurrentWindow();
    const [position, monitor] = await Promise.all([
      floatWin.outerPosition(),
      currentMonitor()
    ]);
    if (!monitor) {
      return window.screenX + window.innerWidth * 0.5 > window.screen.availWidth * 0.5
        ? "left"
        : "right";
    }
    const monitorLeft = monitor.position.x;
    const monitorWidth = monitor.size.width;
    const windowCenter = position.x + window.innerWidth * window.devicePixelRatio * 0.5;
    return windowCenter > monitorLeft + monitorWidth * 0.5 ? "left" : "right";
  } catch {
    return window.screenX + window.innerWidth * 0.5 > window.screen.availWidth * 0.5
      ? "left"
      : "right";
  }
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
