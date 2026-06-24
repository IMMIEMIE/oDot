import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { FloatBall } from "./FloatBall";
import "./styles.css";

const win = getCurrentWindow();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {win.label === "float" ? <FloatBall /> : <App />}
  </React.StrictMode>
);
