# oDot VS Code Bridge

Send selected code, files, and folders from VS Code to the oDot prompt through the local oDot Bridge.

The extension sends reference metadata only: absolute path, optional relative path, language, and line range. It does not send file contents.

## Usage

- Keep oDot running with the Bridge enabled.
- In VS Code, select code and press `Ctrl+L` (`Cmd+L` on macOS).
- In the Explorer, right-click a file or folder and choose `oDot: Send File/Folder to Prompt`.
- Run `oDot: Check Bridge` from the Command Palette if sending fails.

## Configuration

- `odot.bridge.port`: oDot Bridge port. Default: `39871`.
- `odot.bridge.host`: oDot Bridge host. Default: `127.0.0.1`.
- `odot.reference.maxPayloadBytes`: approximate maximum JSON payload size sent to oDot.
- `odot.shortcut.sendReferenceToPrompt`: shortcut for `oDot: Send Selection/File to Prompt`.
  - Default: `primary+l` (`Ctrl+L` on Windows/Linux, `Cmd+L` on macOS).
  - Built-in choices are limited to combinations of up to three keys.
  - Set it to `disabled` if you want to bind the command yourself in VS Code Keyboard Shortcuts.

The port should match oDot's Bridge setting or the `ODOT_BRIDGE_PORT` environment variable used by oDot.
