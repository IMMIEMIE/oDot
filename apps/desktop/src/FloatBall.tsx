import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  Check,
  KeyRound,
  Send,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type PromptPanelDirection = "up" | "right" | "down" | "left";
type SideBubbleDirection = "right" | "left";

const DRAG_THRESHOLD = 4;
const THEME_STORAGE_KEY = "odot.themeMode";
const COMPLETE_CHECK_DURATION_MS = 1_800;
const FLOAT_SLEEP_DELAY_MS = 30_000;

export function FloatBall() {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const [agentStatus, setAgentStatus] = useState(loadFloatAgentStatus);
  const [promptDirection, setPromptDirection] = useState<PromptPanelDirection | null>(null);
  const [promptText, setPromptText] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [panelError, setPanelError] = useState("");
  const [isSubmittingPrompt, setIsSubmittingPrompt] = useState(false);
  const [isResolvingApproval, setIsResolvingApproval] = useState(false);
  const [isActionRingVisible, setIsActionRingVisible] = useState(false);
  const [isSleeping, setIsSleeping] = useState(false);
  const [showCompleteCheck, setShowCompleteCheck] = useState(false);
  const [thinkingBubbleDirection, setThinkingBubbleDirection] =
    useState<SideBubbleDirection>("right");
  const [isApprovalPanelOpen, setIsApprovalPanelOpen] = useState(false);
  const [approvalBubbleDirection, setApprovalBubbleDirection] =
    useState<SideBubbleDirection>("right");
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const completeCheckTimer = useRef<number | undefined>(undefined);
  const sleepTimer = useRef<number | undefined>(undefined);
  const cancelledErrorSession = useRef<string | undefined>(undefined);
  const previousStatusKind = useRef<FloatAgentStatusKind>(agentStatus.kind);

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
    recordFloatMouseEvent();
    return () => {
      if (sleepTimer.current) {
        window.clearTimeout(sleepTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const previous = previousStatusKind.current;
    previousStatusKind.current = agentStatus.kind;
    const transitionedToComplete =
      (previous === "working" || previous === "thinking") && agentStatus.kind === "complete";
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
    if (agentStatus.kind !== "approval") {
      setIsApprovalPanelOpen(false);
    }
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
      .finally(() => setIsDragging(false));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    recordFloatMouseEvent();
    const dragged = didDrag.current;
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
    if (dragged) {
      return;
    }
    if (agentStatus.kind === "approval") {
      setIsActionRingVisible(false);
      setPanelError("");
      setIsApprovalPanelOpen((current) => !current);
      void resolveSideBubbleDirection().then(setApprovalBubbleDirection);
    } else {
      void restoreMainWindow();
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    recordFloatMouseEvent();
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
  };

  function openPromptPanel(direction: PromptPanelDirection) {
    setIsActionRingVisible(false);
    setPromptDirection(direction);
    setPanelError("");
  }

  function closePromptPanel() {
    setPromptDirection(null);
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
    setAttachments([]);
    closePromptPanel();
    setAgentStatus((current) => syncLocalStatus({
      ...current,
      kind: "working",
      label: t("float.agentWorking"),
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
      setAgentStatus(loadFloatAgentStatus());
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
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: action === "reject" ? "idle" : "working",
        label: action === "reject" ? t("float.commandRejected") : t("float.agentWorking"),
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
  const showThinkingBubble = isAgentActive && liveMessage.length > 0;
  const shouldRenderMarkdown = agentStatus.kind === "working";
  const showApprovalPanel =
    isApprovalPending && isApprovalPanelOpen && Boolean(agentStatus.pendingApproval);
  const promptPanelClass = promptDirection
    ? `floatPromptPanel floatPromptPanel--${promptDirection}`
    : "floatPromptPanel";
  const canSendPrompt =
    Boolean(promptText.trim() || attachments.length) &&
    Boolean(agentStatus.sessionId) &&
    !isSubmittingPrompt;
  const containerClassName = [
    "floatBallContainer",
    promptDirection ? "floatBallContainer--panelOpen" : "",
    isActionRingVisible ? "floatBallContainer--actionsVisible" : "",
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
    showCompleteCheck ? "floatBall--complete" : ""
  ].filter(Boolean).join(" ");
  const approvalTitle = agentStatus.pendingApproval?.command.trim();

  return (
    <div
      className={containerClassName}
      onPointerLeave={() => setIsActionRingVisible(false)}
    >
      {canOpenPrompt && (
        <div className="floatActionRing" aria-hidden={isActionRingVisible ? undefined : "true"}>
          <button
            type="button"
            className="floatArrow floatArrow--up"
            aria-label={t("prompt.openUp")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPromptPanel("up");
            }}
          >
            <ArrowUp size={15} />
          </button>
          <button
            type="button"
            className="floatArrow floatArrow--right"
            aria-label={t("prompt.openRight")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPromptPanel("right");
            }}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            className="floatArrow floatArrow--down"
            aria-label={t("prompt.openDown")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPromptPanel("down");
            }}
          >
            <ArrowDown size={15} />
          </button>
          <button
            type="button"
            className="floatArrow floatArrow--left"
            aria-label={t("prompt.openLeft")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPromptPanel("left");
            }}
          >
            <ArrowLeft size={15} />
          </button>
        </div>
      )}

      <button
        type="button"
        className={floatBallClassName}
        onPointerDown={(event) => {
          handlePointerDown(event);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={() => {
          recordFloatMouseEvent();
          setIsActionRingVisible(true);
        }}
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

      {showThinkingBubble && (
        <section
          className={`floatThinkingBubble floatThinkingBubble--${thinkingBubbleDirection}`}
          aria-live="polite"
        >
          <div className="floatThinkingBubbleHeader">
            <span>{agentStatus.label}</span>
          </div>
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
        </section>
      )}

      {promptDirection && (
        <form
          className={promptPanelClass}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt();
          }}
        >
          <div className="floatPanelHeader">
            <span>{t("prompt.continueSession")}</span>
            <button
              type="button"
              className="floatPanelIconButton"
              aria-label={t("prompt.closePanel")}
              onClick={closePromptPanel}
            >
              <X size={13} />
            </button>
          </div>
          <textarea
            className="floatPromptInput"
            value={promptText}
            placeholder={t("prompt.placeholder")}
            disabled={isSubmittingPrompt}
            onChange={(event) => setPromptText(event.target.value)}
            onFocus={() => {
              setIsActionRingVisible(false);
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

      {showApprovalPanel && agentStatus.pendingApproval && (
        <section
          className={`floatApprovalPanel floatApprovalPanel--${approvalBubbleDirection}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="floatPanelHeader">
            <span>{t("prompt.waitingApproval")}</span>
          </div>
          <code className="floatCommandPreview">
            {agentStatus.pendingApproval.command}
          </code>
          {panelError && <div className="floatPanelError">{panelError}</div>}
          <div className="floatApprovalActions">
            <button
              type="button"
              className="floatPrimaryButton"
              disabled={isResolvingApproval}
              onClick={() => void resolveApproval("approve")}
            >
              {t("common.approve")}
            </button>
            <button
              type="button"
              className="floatSecondaryButton"
              disabled={isResolvingApproval}
              onClick={() => void resolveApproval("allow")}
            >
              {t("common.addToAllowlist")}
            </button>
            <button
              type="button"
              className="floatDangerButton"
              disabled={isResolvingApproval}
              onClick={() => void resolveApproval("reject")}
            >
              {t("common.reject")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
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
