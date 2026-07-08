# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

oDot is a Tauri 2.x desktop app: an IDE-agnostic AI coding assistant with Ask/Plan/Agent modes, safe file mutations (snapshot + rollback), shell command approval, and a floating agent window. Frontend is React 18 + TypeScript + Vite; backend is Rust (Tauri commands) with SQLite (via rusqlite, WAL mode) for session/event/snapshot persistence.

## Commands

```bash
npm install                 # install JS deps
npm run tauri:dev           # full desktop dev mode (Tauri + Vite)
npm run dev:web             # browser-only dev: runs Vite + Express (apps/server) concurrently, Express proxies API on port 4317
npm run typecheck           # tsc -p tsconfig.json --noEmit
npm run build:desktop       # typecheck + vite build
npm run tauri:build:app     # release build, no bundler (output: src-tauri/target/release/odot.exe)
npm run icons:generate      # regenerate app icons from src-tauri/app-icon.svg
```

Rust backend (run from `src-tauri/`):
```bash
cargo build
cargo test                  # run all tests
cargo test <name>           # run a single test by name (e.g. cargo test parse_sse_line)
```
Rust unit tests live inline in `#[cfg(test)] mod tests` blocks at the bottom of the relevant source file (e.g. `config_file.rs`, `error_model.rs`, `i18n.rs`, `llm_runtime.rs`) rather than in a separate tests directory.

There is no JS test runner configured — `npm run typecheck` is the primary JS-side correctness check.

## Architecture

### Two ways to run the frontend
`apps/desktop` is a single React app that runs either inside Tauri (`tauri:dev`/`tauri:dev` — talks to Rust via `@tauri-apps/api` invoke calls) or standalone in a browser against `apps/server` (an Express server that proxies to the same commands over HTTP for fast UI iteration without a Rust rebuild). `packages/core` holds TypeScript types/logic (`aiProvider.ts`, `diffPreview.ts`, `types.ts`, `workspace.ts`) shared between the desktop app and the web-fallback server so both entry points stay in sync.

### Rust backend module map (`src-tauri/src/`)
- `lib.rs` — Tauri app setup, all `#[tauri::command]` handlers registered via `generate_handler!`, window management (main + floating agent window, drag handling).
- `runner.rs` — the agent loop: orchestrates LLM calls, tool execution, and context compression for a session.
- `provider.rs` — outbound LLM API calls (OpenAI and Anthropic style; also OpenAI-compatible/Anthropic-compatible per `odot.json` provider config).
- `llm_runtime.rs` — SSE stream parsing for streamed model responses.
- `tools.rs` — the tool execution engine invoked by the agent loop (file read/write/edit, shell, etc.).
- `mutation.rs` — file mutation operations plus snapshot tracking (SHA-256 + unified diff) that backs rollback.
- `config_file.rs` — parses `odot.json` (provider/model config, OpenCode-compatible schema).
- `storage.rs` — SQLite layer: sessions, events, snapshots, context summaries, permission requests, background jobs.
- `event_bus.rs` — real-time event broadcasting from backend to frontend (drives the live session timeline).
- `session_coordinator.rs` — coordinates session lifecycle across sub-agent sessions.
- `task_registry.rs` — background/detached job tracking.
- `workspace.rs` — project/workspace file operations and capability detection.
- `mcp.rs` — MCP (Model Context Protocol) server integration.
- `skills.rs` — skill definitions/loading.
- `external_bridge.rs` — bridge for external prompt references/integrations.
- `i18n.rs` — backend-side i18n strings.
- `error_model.rs` — structured error types returned across the Tauri boundary.
- `types.rs` — shared request/response DTOs for Tauri commands.

### Frontend structure (`apps/desktop/src/`)
- `App.tsx` — main application UI (session view, agent modes, editors).
- `FloatBall.tsx` — the floating agent window UI.
- `api.ts` — typed wrappers around Tauri `invoke` calls (mirrors the Rust command surface in `lib.rs`).
- `sessionStore.ts` — Zustand store for the live event timeline, fed by `event_bus.rs` events.
- `promptAttachments.ts`, `promptDraft.ts`, `promptInlineReferences.ts`, `externalPromptReferences.ts`, `floatAgentStatus.ts` — prompt composer state (attachments, inline/external references, drafts) and floating-window agent status sync.
- `i18n/locales/{en,zh}.json` — frontend translation strings.

### Configuration and data
- `odot.json` (project root or app data dir) configures LLM providers/models; format is compatible with OpenCode's `config.json` schema. Provider type is auto-detected from the `api` URL or `npm` field (`openai`, `anthropic`, `openai-compatible`, `anthropic-compatible`). API keys resolve in order: `options.apiKey` in config → env var named by `env` field → system keychain.
- Session data lives in a local SQLite DB (`%APPDATA%/dev.odot.desktop/odot.db` on Windows) with tables: `session`, `event`, `snapshot`, `context_summary`, `permission_request`, `background_job`.

### Cross-cutting patterns
- Every file mutation (edit/create/delete) is snapshotted (before/after content + unified diff, SHA-256) before applying, enabling one-click rollback; path-level mutex locks prevent concurrent writes to the same file.
- Shell commands run under one of two policies (`manual` — always approve; `auto` — low-risk auto-run, dangerous commands still require approval), configured per session.
- Long sessions auto-compress past an event-count threshold; the summary (goals/constraints/progress/decisions/next steps) is persisted in `context_summary` and re-injected into subsequent turns.

Also present: `oDotVscode/` (a separate VS Code extension package with its own `package.json`/`tsconfig.json`, not part of the root npm workspace scripts above).
