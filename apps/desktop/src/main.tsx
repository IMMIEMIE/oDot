import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { FloatBall } from "./FloatBall";
import "./i18n";
import "./styles.css";

const win = getCurrentWindow();
const isFloatWindow = win.label === "float";
const root = document.getElementById("root")!;

document.documentElement.classList.toggle("float-window", isFloatWindow);
document.body.classList.toggle("float-window-body", isFloatWindow);
root.classList.toggle("floatRoot", isFloatWindow);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {isFloatWindow ? <FloatBall /> : <App />}
  </React.StrictMode>
);
