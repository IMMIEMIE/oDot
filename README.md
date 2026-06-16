# oDot

oDot is an early-stage local AI coding assistant. This first version focuses on one practical loop:

1. Configure an OpenAI-compatible model provider.
2. Open a local project directory.
3. Select files.
4. Ask the model for a code change.
5. Review the generated diff.
6. Apply the change with a local backup.

## Tech Shape

- `apps/desktop`: React + Vite desktop-facing UI.
- `src-tauri`: Tauri 2 + Rust desktop shell and local commands.
- `apps/server`: Optional Node API fallback for browser-only debugging.
- `packages/core`: Earlier TypeScript core reference used by the web fallback.

The desktop app uses Rust commands for workspace scanning, OpenAI-compatible provider calls, diff previews, safe writes, and backups. The UI still has a browser fallback so the same screen can be debugged through Vite.

## Quick Start

```bash
npm install
npm run tauri:dev
```

For a release executable:

```bash
npm run tauri:build:app
```

The executable is written to `src-tauri/target/release/odot.exe` on Windows.

For browser-only debugging with the old local Node fallback:

```bash
npm run dev:web
```

Then open `http://127.0.0.1:5173`.

## Provider Notes

Use an OpenAI-compatible Chat Completions endpoint:

- OpenAI: `https://api.openai.com/v1`
- DeepSeek: `https://api.deepseek.com`
- Ollama: `http://127.0.0.1:11434/v1`

The model response is requested as strict JSON and converted into file-level diffs before any write happens.

## Safety

- oDot only edits files explicitly selected in the UI.
- Writes are blocked if a selected file changed after the proposal was generated.
- Original files are backed up under `.odot/backups/<timestamp>/`.
- Project scanning skips heavy/generated folders such as `.git`, `node_modules`, `dist`, `build`, `.next`, and `.odot`.
