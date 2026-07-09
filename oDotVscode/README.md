# oDot VS Code Bridge

Send selected code, files, and folders from VS Code to the oDot prompt through the local oDot Bridge.

The extension sends reference metadata only: absolute path, optional relative path, language, and line range. It does not send file contents.

## Usage

- Start VS Code normally. The extension launches oDot through `odot://bridge/wake` when needed.
- In VS Code, select code and press `Ctrl+L` (`Cmd+L` on macOS).
- In the Explorer, right-click a file or folder and choose `oDot: Send File/Folder to Prompt`.
- Run `oDot: Check Bridge` from the Command Palette if sending fails.

## Configuration

- `odot.bridge.timeoutMs`: timeout for authenticated local Bridge requests.
- `odot.reference.maxPayloadBytes`: approximate maximum JSON payload size sent to oDot.
- `odot.shortcut.sendReferenceToPrompt`: shortcut for `oDot: Send Selection/File to Prompt`.
  - Default: `primary+l` (`Ctrl+L` on Windows/Linux, `Cmd+L` on macOS).
  - Built-in choices are limited to combinations of up to three keys.
  - Set it to `disabled` if you want to bind the command yourself in VS Code Keyboard Shortcuts.

The extension discovers the loopback port and per-launch authentication token from `~/.odot/bridge.json`; no host or port configuration is required.
