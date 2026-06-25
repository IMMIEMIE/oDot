import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  KeyRound,
  Send,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { OdodBotIcon } from "./OdodBotIcon";
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
type PromptPanelDirection = "up" | "right" | "down" | "left";

const DRAG_THRESHOLD = 4;

export function FloatBall() {
  const [isDragging, setIsDragging] = useState(false);
  const [agentStatus, setAgentStatus] = useState(loadFloatAgentStatus);
  const [promptDirection, setPromptDirection] = useState<PromptPanelDirection | null>(null);
  const [promptText, setPromptText] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [panelError, setPanelError] = useState("");
  const [isSubmittingPrompt, setIsSubmittingPrompt] = useState(false);
  const [isResolvingApproval, setIsResolvingApproval] = useState(false);
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const didDrag = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem("odot.themeMode");
    const mode: ThemeMode =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const resolved =
      mode === "system" ? (media.matches ? "dark" : "light") : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
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
      setPanelError("当前模型不支持附件");
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
      setPanelError("没有当前会话");
      return;
    }
    setIsSubmittingPrompt(true);
    setPanelError("");
    setAgentStatus((current) => syncLocalStatus({
      ...current,
      kind: "idle",
      label: "Agent 工作中",
      pendingApproval: null
    }));
    try {
      await promptSession({
        sessionId: agentStatus.sessionId,
        prompt: prompt || "请根据附件内容继续。",
        attachments: attachments.map(toPromptAttachmentInput),
        delivery: "queue",
        resume: true
      });
      await notifyMainSessionRefresh(agentStatus.sessionId);
      setPromptText("");
      setAttachments([]);
      closePromptPanel();
      setAgentStatus(loadFloatAgentStatus());
    } catch (error) {
      setPanelError(errorSummary(error));
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: "error",
        label: "Agent 报错"
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
        label: action === "reject" ? "命令已拒绝" : "Agent 工作中",
        pendingApproval: null
      }));
    } catch (error) {
      setPanelError(errorSummary(error));
      setAgentStatus((current) => syncLocalStatus({
        ...current,
        kind: "error",
        label: "Agent 报错"
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

  return (
    <div className={`floatBallContainer${promptDirection ? " floatBallContainer--panelOpen" : ""}`}>
      {canOpenPrompt && (
        <div className="floatActionRing" aria-hidden={promptDirection ? "true" : undefined}>
          <button
            type="button"
            className="floatArrow floatArrow--up"
            aria-label="向上打开输入框"
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
            aria-label="向右打开输入框"
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
            aria-label="向下打开输入框"
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
            aria-label="向左打开输入框"
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
        className={`floatBall floatBall--${agentStatus.kind}${isDragging ? " floatBall--dragging" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        title={agentStatus.label}
      >
        <FloatAgentStatusIcon kind={agentStatus.kind} />
      </button>

      {promptDirection && (
        <form
          className={promptPanelClass}
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt();
          }}
        >
          <div className="floatPanelHeader">
            <span>继续当前会话</span>
            <button
              type="button"
              className="floatPanelIconButton"
              aria-label="关闭输入框"
              onClick={closePromptPanel}
            >
              <X size={13} />
            </button>
          </div>
          <textarea
            className="floatPromptInput"
            value={promptText}
            placeholder="输入 prompt，Enter 发送"
            disabled={isSubmittingPrompt}
            onChange={(event) => setPromptText(event.target.value)}
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
                  {attachment.kind === "image" ? "图片" : "文本"} · {formatBytes(attachment.size)}
                  <button
                    type="button"
                    aria-label={`移除 ${attachment.name}`}
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
            <span>{isSubmittingPrompt ? "发送中..." : "可粘贴附件"}</span>
            <button
              type="submit"
              className="floatPrimaryButton"
              disabled={!canSendPrompt}
            >
              <Send size={13} />
              发送
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
            <span>等待批准</span>
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
              批准
            </button>
            <button
              type="button"
              className="floatSecondaryButton"
              disabled={isResolvingApproval}
              onClick={() => void resolveApproval("allow")}
            >
              加白
            </button>
            <button
              type="button"
              className="floatDangerButton"
              disabled={isResolvingApproval}
              onClick={() => void resolveApproval("reject")}
            >
              拒绝
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function FloatAgentStatusIcon({ kind }: { kind: FloatAgentStatusKind }) {
  switch (kind) {
    case "approval":
      return <KeyRound size={28} strokeWidth={2.3} />;
    case "error":
      return <AlertTriangle size={28} strokeWidth={2.3} />;
    case "complete":
    case "idle":
    default:
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
  return "操作失败";
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
