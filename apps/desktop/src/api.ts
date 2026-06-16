import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
};

export type ProjectFile = {
  path: string;
  size: number;
  modifiedAt: string;
  language: string;
};

export type ProposedFileChange = {
  path: string;
  originalContent: string;
  updatedContent: string;
  patch: string;
};

export type ChangePlan = {
  id: string;
  summary: string;
  createdAt: string;
  provider: string;
  model: string;
  changes: ProposedFileChange[];
  rawResponse: string;
};

export async function fetchProjectFiles(root: string): Promise<ProjectFile[]> {
  if (isTauri()) {
    return invoke<ProjectFile[]>("list_project_files", { root });
  }

  const payload = await postJson<{ files: ProjectFile[] }>("/api/project/files", {
    root
  });
  return payload.files;
}

export async function proposeChange(input: {
  root: string;
  paths: string[];
  instruction: string;
  provider: ProviderConfig;
}): Promise<ChangePlan> {
  if (isTauri()) {
    return invoke<ChangePlan>("propose_code_change", input);
  }

  const payload = await postJson<{ plan: ChangePlan }>("/api/ai/propose", input);
  return payload.plan;
}

export async function applyChanges(input: {
  root: string;
  changes: ProposedFileChange[];
}): Promise<{ applied: string[]; backupDir: string }> {
  if (isTauri()) {
    return invoke<{ applied: string[]; backupDir: string }>("apply_file_changes", input);
  }

  const payload = await postJson<{
    result: { applied: string[]; backupDir: string };
  }>("/api/changes/apply", input);
  return payload.result;
}

export async function pickProjectDirectory(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择 oDot 项目目录"
  });

  return typeof selected === "string" ? selected : null;
}

async function postJson<TResponse>(
  url: string,
  body: unknown
): Promise<TResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error ?? "oDot request failed.");
  }

  return payload as TResponse;
}
