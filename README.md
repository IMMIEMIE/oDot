**[中文](README.zh-CN.md)** | English

# ![128x128](E:\oDot\src-tauri\icons\128x128.png)    **oDot**

An IDE-agnostic AI programming assistant with an innovative floating ball mode. No more juggling different coding plugins across IDEs, and no more losing precious screen real estate to dialog windows. Simply configure any OpenAI-compatible model provider, open your project directory, and start coding.

---

This project is in its early stages, so your feedback and suggestions are incredibly valuable! If you run into any issues or would like to see new features in the future, please share your thoughts.

## Core Features

**Three Agent Modes**

- **Ask** — The agent can read and search project files but won't modify anything. Ideal for asking questions about your codebase.
- **Plan** — Builds on Ask mode with the ability to run approved shell commands for research, ultimately producing a concrete implementation plan without modifying any files.
- **Agent** — Full autonomous mode. Can read, edit, create, and delete files, as well as run verification commands.

**Safe File Changes**

Every file modification (edit, create, delete) generates a snapshot containing the full before-and-after content and a unified diff. Any individual change can be rolled back with a single click. Path-level mutex locks prevent concurrent modifications to the same file.

**Shell Command Approval**

Two shell modes: `manual` (every command requires approval) and `auto` (low-risk commands execute automatically, dangerous commands still require approval). The auto-allow list is configurable per session.

**Context Compression**

Long sessions are automatically compressed when the event count exceeds a threshold. Compression produces a structured summary (goals, constraints, progress, decisions, next steps) that is injected into subsequent conversations, ensuring the agent never loses working context.

**Sub-Agent Sessions**

Isolated sub-agent sessions can be launched for focused parallel work. Each sub-agent runs in its own independent session with a dedicated event timeline.

**Snapshots & Rollback**

All changes are recorded with SHA-256 hashes and unified diffs. The rollback system restores files to their pre-change state — if a file was created, rollback deletes it; if a file was deleted, rollback recreates it.

**Floating Agent Window**

A topmost transparent floating window that lets you interact with the agent without leaving your editor or browser.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Framework | Tauri 2.x (Rust) |
| Frontend | React 18 + TypeScript + Vite |
| State Management | Zustand |
| Database | SQLite (WAL mode, via rusqlite) |
| Secret Storage | System Keychain (Windows Credential Manager / macOS Keychain) |
| LLM Streaming | reqwest + futures-util (SSE parsing) |
| File Integrity | SHA-256 (sha2 crate) |
| Markdown Rendering | react-markdown + remark-gfm |

## Getting Started

### Prerequisites

- Node.js 18+
- Rust toolchain (edition 2021, minimum rustc 1.77.2)
- Tauri 2.x prerequisites ([Installation Guide](https://tauri.app/start/prerequisites/))

### Development Mode

```bash
# Clone the repository
git clone https://github.com/your-username/oDot.git
cd oDot

# Install dependencies
npm install

# Start development mode
npm run tauri:dev
```

### Build

```bash
# Build the desktop app (without bundler)
npm run tauri:build:app
```

The build output is located at `src-tauri/target/release/odot.exe` (Windows).

### Browser-Only Development (Optional)

For rapid frontend iteration without launching Tauri:

```bash
npm run dev:web
```

This runs both Vite and Express simultaneously. The Express server proxies API requests on port 4317, making it easy to debug in the browser.

## Configuration

oDot uses an `odot.json` file in the project root (or the application data directory) to configure providers and models. The configuration format is compatible with [OpenCode](https://opencode.ai).

### Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-4o",
  "provider": {
    "openai": {
      "name": "OpenAI",
      "api": "https://api.openai.com/v1",
      "options": {
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "gpt-4o": {
          "limit": {
            "context": 128000
          }
        }
      }
    }
  }
}
```

### Provider Types

> **Note:** The current version has poor compatibility with the Anthropic API (largely unusable). It is recommended to use OpenAI or OpenAI-compatible interfaces.

oDot automatically detects the provider type based on the `api` URL or `npm` field:

- `openai` — Native OpenAI API
- `anthropic` — Native Anthropic API
- `openai-compatible` — Any OpenAI-compatible interface
- `anthropic-compatible` — Any Anthropic-compatible interface

Tool mode (`native`, `json`, or `auto`) can be configured per provider or per model.

### API Key Management

API keys are resolved in the following order:

1. `options.apiKey` in `odot.json`
2. Environment variable specified by the `env` field
3. System Keychain (stored on first use via the settings UI)

## Project Structure

```
oDot/
├── apps/
│   ├── desktop/          # React + Vite frontend
│   │   └── src/
│   │       ├── App.tsx           # Main application UI
│   │       ├── FloatBall.tsx     # Floating agent window
│   │       ├── api.ts            # Tauri invoke wrappers
│   │       ├── sessionStore.ts   # Zustand live event store
│   │       └── styles.css        # Application styles
│   └── server/           # Optional Express fallback server
├── packages/
│   └── core/             # Shared TypeScript types (web fallback)
├── src-tauri/            # Rust backend
│   └── src/
│       ├── lib.rs                # Tauri command handlers (32 commands)
│       ├── runner.rs             # Agent loop, LLM orchestration, context compression
│       ├── tools.rs              # Tool execution engine
│       ├── provider.rs           # LLM API calls (OpenAI + Anthropic)
│       ├── llm_runtime.rs        # SSE stream parser
│       ├── storage.rs            # SQLite database layer
│       ├── mutation.rs           # File operations & snapshot tracking
│       ├── config_file.rs        # odot.json config parser
│       ├── event_bus.rs          # Real-time event broadcasting
│       └── error_model.rs        # Structured error types
├── odot.json             # Sample project configuration
└── package.json          # Root monorepo configuration
```

## Data Storage

oDot stores all session data in a local SQLite database (located at `%APPDATA%/dev.odot.desktop/odot.db` on Windows). The database contains the following core tables:

- `session` — Session records including mode, provider, token statistics, etc.
- `event` — Timeline events (prompts, tool calls, model responses, snapshots, etc.)
- `snapshot` — File change records with before/after content and diffs
- `context_summary` — Compressed summaries for long sessions
- `permission_request` — Shell command approval records
- `background_job` — Background detached process tracking

## License

This project is open-sourced under the MIT License.
