import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "apps/desktop",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Tauri's devUrl is hard-pinned to 127.0.0.1:5173; fail loudly if the port is
    // taken instead of silently shifting to one Tauri won't load.
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "../../dist/desktop",
    emptyOutDir: true
  }
});

