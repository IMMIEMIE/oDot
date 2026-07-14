# oDot VS Code Bridge

Send selected code, files, and folders from VS Code to the oDot prompt through the local oDot Bridge.

The extension sends reference metadata only: absolute path, optional relative path, language, and line range. It does not send file contents.

## Usage

- Start VS Code normally. The extension launches oDot through `odot://bridge/wake` when needed.
- In VS Code, select code and press `Ctrl+Shift+L` (`Cmd+Shift+L` on macOS).
- In the Explorer, right-click a file or folder and choose `oDot: Send File/Folder to Prompt`.
- Run `oDot: Check Bridge` from the Command Palette if sending fails.

## Configuration

- `odot.bridge.timeoutMs`: timeout for authenticated local Bridge requests.
- `odot.reference.maxPayloadBytes`: approximate maximum JSON payload size sent to oDot.

### Shortcut

- `oDot: Send Selection/File to Prompt` ships a default binding of `Ctrl+Shift+L` (`Cmd+Shift+L` on macOS).
- Rebind it to any combination in the native **Keyboard Shortcuts** editor (`Ctrl+K Ctrl+S`, then search `oDot`). VS Code supports multi-modifier keys and chord sequences, so three-key (and larger) combos are all available; you can also remove the binding there.
- Shortcut: run `oDot: Configure Send Shortcut` from the Command Palette — it opens the Keyboard Shortcuts editor pre-filtered to this command.

The extension discovers the loopback port and per-launch authentication token from `~/.odot/bridge.json`; no host or port configuration is required.
