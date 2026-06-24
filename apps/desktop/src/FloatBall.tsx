import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ThemeMode = "system" | "light" | "dark";

const DRAG_THRESHOLD = 4;

export function FloatBall() {
  const [isDragging, setIsDragging] = useState(false);
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

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
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

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
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

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragged = didDrag.current;
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
    if (!dragged) {
      void restoreMainWindow();
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    resetPointer(event.currentTarget, event.pointerId);
    didDrag.current = false;
  };

  return (
    <div className="floatBallContainer">
      <button
        type="button"
        className={`floatBall${isDragging ? " floatBall--dragging" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        title="Click to restore oDot, drag to move"
      >
        <Bot size={28} />
      </button>
    </div>
  );
}
