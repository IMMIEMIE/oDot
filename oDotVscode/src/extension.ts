import * as http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  canRestartAfterManualShutdown,
  normalizeWorkspaceRoot,
  shouldPublishWorkspace,
  shouldWakeODot
} from "./workspaceSync";

type ExternalPromptReferenceItem = {
  itemType?: string | null;
  path?: string | null;
  absolutePath?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  language?: string | null;
};

type ExternalPromptReferencePayload = {
  workspaceRoot?: string | null;
  source?: string | null;
  mode?: string | null;
  items: ExternalPromptReferenceItem[];
};

type BridgeDiscovery = {
  protocolVersion: number;
  host: string;
  port: number;
  token: string;
  executablePath?: string | null;
  pid: number;
  startedAt: number;
};

type BridgeConfig = BridgeDiscovery & {
  timeoutMs: number;
};

type WorkspaceReason = "activation" | "editor-change" | "folder-change" | "focus";

const sourceName = "vscode";
const PROTOCOL_VERSION = 2;
const BRIDGE_HEARTBEAT_INTERVAL_MS = 4000;
const BRIDGE_WAKE_RETRY_MS = 15000;
let publishWorkspaceTimer: NodeJS.Timeout | undefined;
let bridgeHeartbeatTimer: NodeJS.Timeout | undefined;
let lastPublishedWorkspaceRoot = "";
let bridgeReachable = false;
let clientId = "";
let installationId = "";
let instanceId = "";
let sequence = 0;
let windowFocused = true;
let lastWakeAttempt = 0;
let protocolWarningShown = false;
let fallbackWakeAttempted = false;

export async function activate(context: vscode.ExtensionContext) {
  installationId =
    context.globalState.get<string>("odot.bridge.installationId") ?? randomUUID();
  await context.globalState.update("odot.bridge.installationId", installationId);
  // Each extension host represents one live VS Code window. Keep this id stable
  // while that host is alive, but never share it through workspaceState with a
  // second window that opens the same folder.
  instanceId = randomUUID();
  clientId = `${sourceName}:${instanceId}`;
  windowFocused = vscode.window.state.focused;
  context.subscriptions.push(
    vscode.commands.registerCommand("odot.sendReferenceToPrompt", sendReferenceToPrompt),
    vscode.commands.registerCommand("odot.sendResourceToPrompt", sendResourceToPrompt),
    vscode.commands.registerCommand("odot.configureShortcut", configureShortcut),
    vscode.commands.registerCommand("odot.checkBridge", checkBridge),
    vscode.window.onDidChangeActiveTextEditor(() => {
      schedulePublishWorkspaceSessions("editor-change");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      schedulePublishWorkspaceSessions("folder-change", true);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      void sendHeartbeat();
      if (state.focused) {
        schedulePublishWorkspaceSessions("focus", true);
      }
    })
  );
  startBridgeHeartbeat(context);
  schedulePublishWorkspaceSessions("activation", true);
}

export async function deactivate() {
  if (publishWorkspaceTimer) {
    clearTimeout(publishWorkspaceTimer);
    publishWorkspaceTimer = undefined;
  }
  if (bridgeHeartbeatTimer) {
    clearInterval(bridgeHeartbeatTimer);
    bridgeHeartbeatTimer = undefined;
  }
  // Best-effort: tell oDot this window is gone so its monitor drops the row
  // immediately instead of waiting for the heartbeat-timeout reaper.
  if (!clientId) {
    return;
  }
  try {
    const config = await bridgeConfig();
    await requestJson(config, "POST", "/v2/client/disconnect", {
      protocolVersion: PROTOCOL_VERSION,
      clientId,
      sequence: nextSequence(),
      focused: false,
      workspaceRoot: currentWorkspaceFolder()?.uri.fsPath ?? null,
      source: sourceName,
      displayName: "VS Code",
      installationId,
      instanceId,
      sentAt: Date.now()
    });
  } catch {
    // The bridge may already be gone; the reaper handles cleanup regardless.
  }
}

// Poll the oDot bridge so the extension notices when oDot (re)starts. On every
// unreachable -> reachable transition we force a fresh workspace publish, which
// makes oDot re-run its session-matching logic and keeps the IDE and the app
// pinned to the same project directory (requirement: sync on each oDot startup).
function startBridgeHeartbeat(context: vscode.ExtensionContext) {
  const tick = () => {
    void pollBridgeReachability();
  };
  bridgeHeartbeatTimer = setInterval(tick, BRIDGE_HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => {
      if (bridgeHeartbeatTimer) {
        clearInterval(bridgeHeartbeatTimer);
        bridgeHeartbeatTimer = undefined;
      }
    }
  });
  tick();
}

async function pollBridgeReachability() {
  const requestSequence = nextSequence();
  try {
    const config = await bridgeConfig();
    const response = await requestJson(config, "POST", "/v2/client/heartbeat", {
      protocolVersion: PROTOCOL_VERSION,
      clientId,
      sequence: requestSequence,
      focused: windowFocused,
      workspaceRoot: currentWorkspaceFolder()?.uri.fsPath ?? null,
      source: sourceName,
      displayName: "VS Code",
      installationId,
      instanceId,
      sentAt: Date.now()
    });
    ensureProtocolResponse(response);
    const reachable = response.statusCode >= 200 && response.statusCode < 300;
    if (reachable && !bridgeReachable) {
      bridgeReachable = true;
      await publishWorkspaceSessions("activation", true);
    } else if (!reachable) {
      bridgeReachable = false;
    }
  } catch {
    bridgeReachable = false;
  }
}

async function sendHeartbeat() {
  const requestSequence = nextSequence();
  try {
    const config = await bridgeConfig();
    const response = await requestJson(config, "POST", "/v2/client/heartbeat", {
      protocolVersion: PROTOCOL_VERSION,
      clientId,
      sequence: requestSequence,
      focused: windowFocused,
      workspaceRoot: currentWorkspaceFolder()?.uri.fsPath ?? null,
      source: sourceName,
      displayName: "VS Code",
      installationId,
      instanceId,
      sentAt: Date.now()
    });
    ensureProtocolResponse(response);
    bridgeReachable = response.statusCode >= 200 && response.statusCode < 300;
  } catch {
    bridgeReachable = false;
  }
}

async function sendReferenceToPrompt(resource?: vscode.Uri, selectedResources?: vscode.Uri[]) {
  await runCommand(async () => {
    const explicitResourceItems = await urisToItems(
      normalizeResourceArgs(resource, selectedResources)
    );
    if (explicitResourceItems.length > 0) {
      await sendItems(explicitResourceItems, "resource");
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selectionItems = collectSelectionItems(editor);
      if (selectionItems.length > 0) {
        await sendItems(selectionItems, "selection");
        return;
      }
    }

    const inferredResourceItems = await collectResourceItems();
    if (inferredResourceItems.length > 0) {
      await sendItems(inferredResourceItems, "resource");
      return;
    }

    if (editor) {
      await sendItems([documentToItem(editor.document)], "file");
      return;
    }

    throw new Error("No selected code, file, or folder was found.");
  });
}

async function sendResourceToPrompt(resource?: vscode.Uri, selectedResources?: vscode.Uri[]) {
  await runCommand(async () => {
    const resourceItems = await collectResourceItems(resource, selectedResources);
    if (resourceItems.length === 0) {
      throw new Error("No selected file or folder was found.");
    }
    await sendItems(resourceItems, "resource");
  });
}

async function checkBridge() {
  await runCommand(async () => {
    const config = await bridgeConfig();
    const response = await requestJson(config, "GET", "/v2/status");
    ensureProtocolResponse(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Bridge responded with HTTP ${response.statusCode}: ${response.body}`);
    }
    vscode.window.showInformationMessage(`oDot Bridge is reachable on ${config.host}:${config.port}.`);
  });
}

async function configureShortcut() {
  // Open the native Keyboard Shortcuts editor filtered to the send command. The user can
  // bind any combination there (VS Code supports multi-modifier keys and chord sequences),
  // which is why we no longer ship a fixed enum of preset shortcuts.
  await vscode.commands.executeCommand(
    "workbench.action.openGlobalKeybindings",
    "@command:odot.sendReferenceToPrompt"
  );
}

function schedulePublishWorkspaceSessions(reason: WorkspaceReason, force = false) {
  if (publishWorkspaceTimer) {
    clearTimeout(publishWorkspaceTimer);
  }
  publishWorkspaceTimer = setTimeout(() => {
    publishWorkspaceTimer = undefined;
    void publishWorkspaceSessions(reason, force);
  }, 120);
}

async function publishWorkspaceSessions(reason: WorkspaceReason, force = false) {
  const folder = currentWorkspaceFolder();
  if (!folder) {
    return;
  }
  const workspaceRoot = normalizeWorkspaceRoot(folder.uri.fsPath);
  if (
    !shouldPublishWorkspace({
      focused: windowFocused,
      force,
      workspaceRoot: folder.uri.fsPath,
      lastPublishedWorkspaceRoot
    })
  ) {
    return;
  }
  const requestSequence = nextSequence();
  try {
    const config = await bridgeConfig();
    const response = await requestJson(config, "POST", "/v2/workspace/activate", {
      protocolVersion: PROTOCOL_VERSION,
      clientId,
      sequence: requestSequence,
      focused: windowFocused,
      workspaceRoot: folder.uri.fsPath,
      source: sourceName,
      displayName: "VS Code",
      installationId,
      instanceId,
      reason,
      sentAt: Date.now()
    });
    ensureProtocolResponse(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Bridge responded with HTTP ${response.statusCode}: ${response.body}`);
    }
    lastPublishedWorkspaceRoot = workspaceRoot;
    bridgeReachable = true;
  } catch {
    bridgeReachable = false;
  }
}

function currentWorkspaceFolder() {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri?.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (folder) {
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

async function runCommand(command: () => Promise<void>) {
  try {
    await command();
  } catch (error) {
    let commandError = error;
    if (shouldWakeODot(error)) {
      await wakeODot("explicit");
      try {
        await waitForBridgeReady();
        await command();
        return;
      } catch (retryError) {
        commandError = retryError;
      }
    }
    const message = commandError instanceof Error ? commandError.message : String(commandError);
    vscode.window.showErrorMessage(`oDot: ${message}`);
  }
}

async function collectResourceItems(resource?: vscode.Uri, selectedResources?: vscode.Uri[]) {
  const uris = normalizeResourceArgs(resource, selectedResources);
  if (uris.length > 0) {
    return urisToItems(uris);
  }

  const explorerUris = await inferExplorerSelectionFromClipboard();
  if (explorerUris.length > 0) {
    return urisToItems(explorerUris);
  }

  return [];
}

function normalizeResourceArgs(resource?: vscode.Uri, selectedResources?: vscode.Uri[]) {
  const uris = new Map<string, vscode.Uri>();
  for (const uri of selectedResources ?? []) {
    if (uri?.scheme === "file") {
      uris.set(uri.fsPath, uri);
    }
  }
  if (resource?.scheme === "file") {
    uris.set(resource.fsPath, resource);
  }
  return Array.from(uris.values());
}

async function inferExplorerSelectionFromClipboard() {
  const before = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand("copyFilePath");
    await delay(40);
    const copied = await vscode.env.clipboard.readText();
    if (!copied || copied === before) {
      return [];
    }
    return existingFileUrisFromText(copied);
  } catch {
    return [];
  } finally {
    await vscode.env.clipboard.writeText(before);
  }
}

async function existingFileUrisFromText(value: string) {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed) || !path.isAbsolute(trimmed)) {
      continue;
    }
    const uri = vscode.Uri.file(trimmed);
    try {
      await vscode.workspace.fs.stat(uri);
      seen.add(trimmed);
      uris.push(uri);
    } catch {
      // Ignore non-file clipboard content.
    }
  }
  return uris;
}

async function urisToItems(uris: vscode.Uri[]) {
  const items: ExternalPromptReferenceItem[] = [];
  for (const uri of uris) {
    const stat = await vscode.workspace.fs.stat(uri);
    const itemType = stat.type & vscode.FileType.Directory ? "directory" : "file";
    items.push({
      itemType,
      path: relativePath(uri),
      absolutePath: uri.fsPath,
      language: itemType === "file" ? languageForUri(uri) : null
    });
  }
  return items;
}

function collectSelectionItems(editor: vscode.TextEditor) {
  const document = editor.document;
  ensureFileDocument(document);

  const selections = editor.selections.filter((selection) => !selection.isEmpty);
  return selections.map((selection, index) => {
    const startLine = selection.start.line + 1;
    const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line
      : selection.end.line + 1;
    return {
      itemType: selections.length > 1 ? `selection-${index + 1}` : "selection",
      path: relativePath(document.uri),
      absolutePath: document.uri.fsPath,
      startLine,
      endLine,
      language: document.languageId
    };
  });
}

function documentToItem(document: vscode.TextDocument): ExternalPromptReferenceItem {
  ensureFileDocument(document);
  return {
    itemType: "file",
    path: relativePath(document.uri),
    absolutePath: document.uri.fsPath,
    language: document.languageId
  };
}

function ensureFileDocument(document: vscode.TextDocument) {
  if (document.uri.scheme !== "file") {
    throw new Error("Only files on disk can be sent as oDot references.");
  }
}

async function sendItems(items: ExternalPromptReferenceItem[], mode: string) {
  const payload = fitPayloadToLimit({
    workspaceRoot: workspaceRootForItems(items),
    source: sourceName,
    mode,
    items
  });

  if (payload.items.length === 0) {
    throw new Error("The selected reference is empty or too large to send.");
  }

  const config = await bridgeConfig();
  const response = await requestJson(config, "POST", "/v2/prompt-references", payload);
  ensureProtocolResponse(response);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Bridge responded with HTTP ${response.statusCode}: ${response.body}`);
  }

  const noun = payload.items.length === 1 ? "reference" : "references";
  vscode.window.showInformationMessage(`Sent ${payload.items.length} oDot ${noun}.`);
}

function fitPayloadToLimit(payload: ExternalPromptReferencePayload) {
  const limit = vscode.workspace.getConfiguration("odot.reference").get("maxPayloadBytes", 900000);
  const next: ExternalPromptReferencePayload = {
    ...payload,
    items: [...payload.items]
  };

  while (byteLength(JSON.stringify(next)) > limit && next.items.length > 0) {
    next.items.pop();
  }
  return next;
}

function workspaceRootForItems(items: ExternalPromptReferenceItem[]) {
  for (const item of items) {
    if (!item.absolutePath) {
      continue;
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(item.absolutePath));
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function relativePath(uri: vscode.Uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return path.basename(uri.fsPath);
  }
  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  return relative.split(path.sep).join("/");
}

function languageForUri(uri: vscode.Uri) {
  const ext = path.extname(uri.fsPath).replace(/^\./, "").toLowerCase();
  if (!ext) {
    return null;
  }
  const aliases: Record<string, string> = {
    h: "c",
    hpp: "cpp",
    js: "javascript",
    jsx: "javascriptreact",
    md: "markdown",
    ps1: "powershell",
    py: "python",
    rs: "rust",
    ts: "typescript",
    tsx: "typescriptreact",
    vue: "vue",
    yml: "yaml"
  };
  return aliases[ext] ?? ext;
}

async function bridgeConfig(): Promise<BridgeConfig> {
  const discoveryPath = path.join(os.homedir(), ".odot", "bridge.json");
  const raw = await fs.readFile(discoveryPath, "utf8");
  const discovery = JSON.parse(raw) as Partial<BridgeDiscovery>;
  if (
    discovery.protocolVersion !== PROTOCOL_VERSION ||
    discovery.host !== "127.0.0.1" ||
    !Number.isInteger(discovery.port) ||
    !discovery.token
  ) {
    throw new Error(`Invalid or incompatible oDot bridge discovery file: ${discoveryPath}`);
  }
  return {
    protocolVersion: discovery.protocolVersion,
    host: discovery.host,
    port: discovery.port!,
    token: discovery.token,
    executablePath:
      typeof discovery.executablePath === "string" ? discovery.executablePath : null,
    pid: discovery.pid ?? 0,
    startedAt: discovery.startedAt ?? 0,
    timeoutMs: vscode.workspace.getConfiguration("odot.bridge").get("timeoutMs", 5000)
  };
}

function requestJson(
  config: BridgeConfig,
  method: "GET" | "POST",
  requestPath: string,
  body?: unknown
) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const json = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: config.host,
        port: config.port,
        path: requestPath,
        method,
        timeout: config.timeoutMs,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.token}`,
          ...(json
            ? {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": Buffer.byteLength(json)
              }
            : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Bridge request timed out after ${config.timeoutMs}ms.`));
    });
    request.on("error", reject);
    if (json) {
      request.write(json);
    }
    request.end();
  });
}

function nextSequence() {
  sequence += 1;
  return sequence;
}

function ensureProtocolResponse(response: { statusCode: number; body: string }) {
  if (response.statusCode !== 409 && response.statusCode !== 426) {
    return;
  }
  if (!protocolWarningShown) {
    protocolWarningShown = true;
    vscode.window.showErrorMessage(
      "oDot Bridge protocol mismatch. Update both oDot and the oDot VS Code extension."
    );
  }
  throw new Error("oDot Bridge protocol mismatch.");
}

async function wakeODot(reason: WorkspaceReason | "heartbeat" | "explicit") {
  // Heartbeats and workspace lifecycle events must never resurrect an app the
  // user closed (including a force-kill, which cannot leave a shutdown marker).
  if (!canRestartAfterManualShutdown(reason)) {
    return;
  }
  const now = Date.now();
  if (now - lastWakeAttempt < BRIDGE_WAKE_RETRY_MS) {
    return;
  }
  lastWakeAttempt = now;
  const shutdownMarker = path.join(os.homedir(), ".odot", "manual-shutdown.json");
  const manuallyStopped = await fs.access(shutdownMarker).then(
    () => true,
    () => false
  );
  if (manuallyStopped) {
    await fs.unlink(shutdownMarker).catch(() => undefined);
  }
  try {
    const discovery = JSON.parse(
      await fs.readFile(path.join(os.homedir(), ".odot", "bridge.json"), "utf8")
    ) as Partial<BridgeDiscovery>;
    if (typeof discovery.executablePath === "string" && discovery.executablePath) {
      const child = spawn(discovery.executablePath, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      return;
    }
  } catch {
    // The first launch may not have a discovery file yet; use the URI once.
  }
  if (fallbackWakeAttempted) {
    return;
  }
  fallbackWakeAttempted = true;
  await vscode.env.openExternal(vscode.Uri.parse("odot://bridge/wake")).then(
    () => undefined,
    () => undefined
  );
}

async function waitForBridgeReady(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("oDot did not become ready in time.");
  while (Date.now() < deadline) {
    try {
      const config = await bridgeConfig();
      const response = await requestJson(config, "GET", "/v2/status");
      ensureProtocolResponse(response);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
      }
      lastError = new Error(`Bridge responded with HTTP ${response.statusCode}: ${response.body}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
