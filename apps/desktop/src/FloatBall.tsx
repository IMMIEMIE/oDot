import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ThemeMode = "system" | "light" | "dark";

const DRAG_THRESHOLD = 4;

export function FloatBall() {
  const [isDragging, setIsDragging] = useState(false);
  const [listening, setListening] = useState(false);
  const downScreen = useRef<{ x: number; y: number } | null>(null);
  const winStart = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

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
    if (!listening) return;

    const onMove = (e: MouseEvent) => {
      if (!downScreen.current || !winStart.current) return;
      const dx = e.screenX - downScreen.current.x;
      const dy = e.screenY - downScreen.current.y;
      if (!moved.current) {
        if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) {
          return;
        }
        moved.current = true;
        setIsDragging(true);
      }
      void getCurrentWindow().setPosition(
        new PhysicalPosition(winStart.current.x + dx, winStart.current.y + dy),
      );
    };

    const onUp = async () => {
      setListening(false);
      if (moved.current) {
        setIsDragging(false);
      } else {
        const floatWin = getCurrentWindow();
        const mainWin = await WebviewWindow.getByLabel("main");
        await mainWin?.show();
        await mainWin?.setFocus();
        await floatWin.hide();
      }
      downScreen.current = null;
      winStart.current = null;
      moved.current = false;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [listening]);

  const handleMouseDown = async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    downScreen.current = { x: e.screenX, y: e.screenY };
    moved.current = false;
    try {
      const pos = await getCurrentWindow().outerPosition();
      winStart.current = { x: pos.x, y: pos.y };
      setListening(true);
    } catch {
      downScreen.current = null;
    }
  };

  return (
    <div className="floatBallContainer">
      <button
        type="button"
        className={`floatBall${isDragging ? " floatBall--dragging" : ""}`}
        onMouseDown={(e) => void handleMouseDown(e)}
        title="点击恢复 oDot 窗口，拖动移动位置"
      >
        <Bot size={28} />
      </button>
    </div>
  );
}
