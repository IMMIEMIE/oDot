import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  KeyRound,
  Send,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { OdodBotIcon, SleepingOdodBotIcon } from "./OdodBotIcon";
import { appT } from "./i18n";
import {
  approveToolCall,
  continueSession,
  loadShellPolicy,
  promptSession,
  rejectToolCall,
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

const DRAG_THRESHOLD = 4;
const THEME_STORAGE_KEY = "odot.themeMode";
const FLOAT_SLEEP_DELAY_MS = 30_000;
const COMPLETE_CHECK_DURATION_MS = 1_800;

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
  const [isDormant, setIsDormant] = useState(false);
  const [showCompleteCheck, setShowCompleteCheck] = useState(false);
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const sleepTimer = useRef<number | undefined>(undefined);
  const completeCheckTimer = useRef<number | undefined>(undefined);
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
    const previous = previousStatusKind.current;
    previousStatusKind.current = agentStatus.kind;
    if (previous === "working" && agentStatus.kind === "complete") {
      setShowCompleteCheck(true);
      if (completeCheckTimer.current) {
        window.clearTimeout(completeCheckTimer.current);
      }
      completeCheckTimer.current = window.setTimeout(() => {
        setShowCompleteCheck(false);
      }, COMPLETE_CHECK_DURATION_MS);
    }
    return () => {
      if (completeCheckTimer.current) {
        window.clearTimeout(completeCheckTimer.current);
      }
    };
  }, [agentStatus.kind]);

  useEffect(() => {
    scheduleSleepTimer();
    return () => {
      if (sleepTimer.current) {
        window.clearTimeout(sleepTimer.current);
      }
    };
  }, [agentStatus.kind, promptDirection]);

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

  function canSleep() {
    return !promptDirection && (agentStatus.kind === "idle" || agentStatus.kind === "complete");
  }

  function scheduleSleepTimer() {
    if (sleepTimer.current) {
      window.clearTimeout(sleepTimer.current);
    }
    if (!canSleep()) {
      setIsDormant(false);
      return;
    }
    sleepTimer.current = window.setTimeout(() => {
      setIsDormant(true);
    }, FLOAT_SLEEP_DELAY_MS);
  }

  function wakeFloatBall() {
    setIsDormant(false);
    scheduleSleepTimer();
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
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
    const dragged = didDrag.current;
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
    if (!dragged) {
      void restoreMainWindow();
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
  };

  function openPromptPanel(direction: PromptPanelDirection) {
    wakeFloatBall();
    setIsActionRingVisible(false);
    setPromptDirection(direction);
    setPanelError("");
  }

  function closePromptPanel() {
    setPromptDirection(null);
    setPanelError("");
    scheduleSleepTimer();
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
      if (action === "allow") {
        const policy = await loadShellPolicy();
        const prefix = shellAllowlistPrefix(pending.command);
        if (prefix) {
          await saveShellPolicy({
            autoAllowlist: Array.from(new Set([...policy.autoAllowlist, prefix]))
          });
        }
      }
      if (action === "reject") {
        await rejectToolCall(pending.eventId);
      } else {
        await approveToolCall(pending.eventId);
        if (agentStatus.sessionId) {
          await continueSession(agentStatus.sessionId);
        }
      }
      if (agentStatus.sessionId) {
        await notifyMainSessionRefresh(agentStatus.sessionId);
      }
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: "idle",
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
    isActionRingVisible ? "floatBallContainer--actionsVisible" : ""
  ].filter(Boolean).join(" ");

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
        className={`floatBall floatBall--${agentStatus.kind}${isDragging ? " floatBall--dragging" : ""}${showCompleteCheck ? " floatBall--completeCelebrating" : ""}`}
        onPointerDown={(event) => {
          wakeFloatBall();
          handlePointerDown(event);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={() => {
          wakeFloatBall();
          setIsActionRingVisible(true);
        }}
        title={agentStatus.label}
      >
        <FloatAgentStatusIcon kind={agentStatus.kind} dormant={isDormant} />
        {showCompleteCheck && (
          <span className="floatCompleteCheck" aria-hidden="true">
            <Check size={28} strokeWidth={3.1} />
          </span>
        )}
      </button>

      {promptDirection && (
        <form
          className={promptPanelClass}
          onPointerDown={(event) => {
            wakeFloatBall();
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
              wakeFloatBall();
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

      {agentStatus.kind === "approval" && agentStatus.pendingApproval && (
        <section
          className="floatApprovalPanel"
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

function FloatAgentStatusIcon({
  kind,
  dormant
}: {
  kind: FloatAgentStatusKind;
  dormant: boolean;
}) {
  switch (kind) {
    case "approval":
      return <KeyRound size={28} strokeWidth={2.3} />;
    case "error":
      return <AlertTriangle size={28} strokeWidth={2.3} />;
    case "complete":
    case "idle":
    default:
      if (dormant) {
        return <SleepingOdodBotIcon size={28} strokeWidth={2.3} />;
      }
      return <OdodBotIcon size={28} strokeWidth={2.3} />;
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
