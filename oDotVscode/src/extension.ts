import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";

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

type BridgeConfig = {
  host: string;
  port: number;
  timeoutMs: number;
};

const sourceName = "vscode";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("odot.sendReferenceToPrompt", sendReferenceToPrompt),
    vscode.commands.registerCommand("odot.sendResourceToPrompt", sendResourceToPrompt),
    vscode.commands.registerCommand("odot.checkBridge", checkBridge)
  );
}

export function deactivate() {
  // Nothing to dispose.
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
    const config = bridgeConfig();
    const response = await requestJson(config, "GET", "/health");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Bridge responded with HTTP ${response.statusCode}: ${response.body}`);
    }
    vscode.window.showInformationMessage(`oDot Bridge is reachable on ${config.host}:${config.port}.`);
  });
}

async function runCommand(command: () => Promise<void>) {
  try {
    await command();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

  const config = bridgeConfig();
  const response = await requestJson(config, "POST", "/v1/prompt-references", payload);
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

function bridgeConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration("odot.bridge");
  return {
    host: config.get("host", "127.0.0.1"),
    port: config.get("port", 39871),
    timeoutMs: config.get("timeoutMs", 5000)
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

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
