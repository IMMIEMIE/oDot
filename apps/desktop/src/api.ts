import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "anthropic-compatible";

export type AgentMode = "ask" | "plan" | "agent";
export type ShellMode = "manual" | "auto";

export type ProviderInput = {
  id?: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  model: string;
  apiKey?: string;
};

export type ProviderRecord = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string | null;
  model: string;
  credentialRef: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderConfigFileResponse = {
  path: string;
  content: string;
  providers: ProviderRecord[];
  selectedProviderId?: string | null;
};

export type CreateSessionInput = {
  projectRoot: string;
  mode: AgentMode;
  providerId: string;
  shellMode: ShellMode;
  title?: string;
};

export type SessionRecord = {
  id: string;
  projectRoot: string;
  mode: AgentMode;
  providerId: string;
  title: string;
  status: string;
  shellMode: ShellMode;
  createdAt: string;
  updatedAt: string;
};

export type EventRecord = {
  id: string;
  sessionId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type SnapshotRecord = {
  id: string;
  sessionId: string;
  eventId?: string | null;
  path: string;
  beforeHash: string;
  afterHash: string;
  beforeContent?: string | null;
  afterContent?: string | null;
  patch: string;
  createdAt: string;
};

export type ContextSummaryRecord = {
  id: string;
  sessionId: string;
  text: string;
  recentEventSeq: number;
  createdAt: string;
};

export type SessionEventsResponse = {
  events: EventRecord[];
  snapshots: SnapshotRecord[];
  summaries: ContextSummaryRecord[];
};

export type ProjectFile = {
  path: string;
  size: number;
  modifiedAt: string;
  language: string;
};

export async function saveProvider(
  input: ProviderInput
): Promise<ProviderRecord> {
  assertTauri();
  return invoke<ProviderRecord>("save_provider", { input });
}

export async function listProviders(): Promise<ProviderRecord[]> {
  assertTauri();
  return invoke<ProviderRecord[]>("list_providers");
}

export async function deleteProvider(id: string): Promise<void> {
  assertTauri();
  return invoke<void>("delete_provider", { id });
}

export async function loadProviderConfig(
  projectRoot?: string
): Promise<ProviderConfigFileResponse> {
  assertTauri();
  return invoke<ProviderConfigFileResponse>("load_provider_config", {
    projectRoot: projectRoot?.trim() || null
  });
}

export async function saveProviderConfig(
  content: string,
  projectRoot?: string
): Promise<ProviderConfigFileResponse> {
  assertTauri();
  return invoke<ProviderConfigFileResponse>("save_provider_config", {
    content,
    projectRoot: projectRoot?.trim() || null
  });
}

export async function createSession(
  input: CreateSessionInput
): Promise<SessionRecord> {
  assertTauri();
  return invoke<SessionRecord>("create_session", { input });
}

export async function listSessions(): Promise<SessionRecord[]> {
  assertTauri();
  return invoke<SessionRecord[]>("list_sessions");
}

export async function getSessionEvents(
  sessionId: string
): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("get_session_events", { sessionId });
}

export async function submitPrompt(input: {
  sessionId: string;
  prompt: string;
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("submit_prompt", { input });
}

export async function approveToolCall(eventId: string): Promise<EventRecord> {
  assertTauri();
  return invoke<EventRecord>("approve_tool_call", { eventId });
}

export async function rejectToolCall(eventId: string): Promise<EventRecord> {
  assertTauri();
  return invoke<EventRecord>("reject_tool_call", { eventId });
}

export async function rollbackSnapshot(
  snapshotId: string
): Promise<SnapshotRecord> {
  assertTauri();
  return invoke<SnapshotRecord>("rollback_snapshot", { snapshotId });
}

export async function compactSession(
  sessionId: string
): Promise<ContextSummaryRecord> {
  assertTauri();
  return invoke<ContextSummaryRecord>("compact_session", { sessionId });
}

export async function fetchProjectFiles(root: string): Promise<ProjectFile[]> {
  assertTauri();
  return invoke<ProjectFile[]>("list_project_files", { root });
}

export async function pickProjectDirectory(): Promise<string | null> {
  assertTauri();
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择 oDot 项目目录"
  });

  return typeof selected === "string" ? selected : null;
}

function assertTauri() {
  if (!isTauri()) {
    throw new Error("oDot 桌面 API 只能在 Tauri 应用内使用。");
  }
}
