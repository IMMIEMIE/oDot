import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "anthropic-compatible";

export type AgentMode = "ask" | "plan" | "agent";
export type ShellMode = "manual" | "auto";
export type SessionInputDelivery = "steer" | "queue";
export type PermissionReply = "once" | "always" | "reject";

export type ShellPolicy = {
  autoAllowlist: string[];
};

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

export type PromptAttachmentInput = {
  name: string;
  mime: string;
  size: number;
  kind: "text" | "image";
  content: string;
};

export type CreateSessionInput = {
  projectRoot: string;
  mode: AgentMode;
  providerId: string;
  shellMode: ShellMode;
  title?: string;
  parentSessionId?: string | null;
};

export type SessionRecord = {
  id: string;
  parentSessionId?: string | null;
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

export type SessionInputRecord = {
  id: string;
  sessionId: string;
  prompt: string;
  attachments: Omit<PromptAttachmentInput, "content">[];
  delivery: SessionInputDelivery;
  resume: boolean;
  status: string;
  promotedEventId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionRunRecord = {
  id: string;
  sessionId: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
};

export type SessionCheckpointRecord = {
  id: string;
  sessionId: string;
  runId?: string | null;
  eventId?: string | null;
  label: string;
  stepIndex?: number | null;
  status: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type PermissionRequestRecord = {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  save: string[];
  sourceJson: unknown;
  status: string;
  reply?: PermissionReply | null;
  createdAt: string;
  updatedAt: string;
};

export type BackgroundJobRecord = {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid: number;
  status: string;
  logPath?: string | null;
  startedAt: string;
  endedAt?: string | null;
};

export type SessionEventsResponse = {
  events: EventRecord[];
  snapshots: SnapshotRecord[];
  summaries: ContextSummaryRecord[];
  inputs: SessionInputRecord[];
  runs: SessionRunRecord[];
  checkpoints: SessionCheckpointRecord[];
  permissions: PermissionRequestRecord[];
  jobs: BackgroundJobRecord[];
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

export async function deleteSession(sessionId: string): Promise<void> {
  assertTauri();
  return invoke<void>("delete_session", { sessionId });
}

export async function cancelSession(sessionId: string): Promise<EventRecord> {
  assertTauri();
  return invoke<EventRecord>("cancel_session", { sessionId });
}

export async function updateSessionTitle(input: {
  sessionId: string;
  title: string;
}): Promise<SessionRecord> {
  assertTauri();
  return invoke<SessionRecord>("update_session_title", { input });
}

export async function updateSessionMode(input: {
  sessionId: string;
  mode?: AgentMode;
  shellMode?: ShellMode;
}): Promise<SessionRecord> {
  assertTauri();
  return invoke<SessionRecord>("update_session_mode", { input });
}

export async function getSessionEvents(
  sessionId: string
): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("get_session_events", { sessionId });
}

export async function tailSessionEvents(input: {
  sessionId: string;
  afterSeq?: number;
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("tail_session_events", { input });
}

export async function submitPrompt(input: {
  sessionId: string;
  prompt: string;
  attachments?: PromptAttachmentInput[];
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("submit_prompt", { input });
}

export async function promptSession(input: {
  id?: string;
  sessionId: string;
  prompt: string;
  attachments?: PromptAttachmentInput[];
  delivery?: SessionInputDelivery;
  resume?: boolean;
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("prompt_session", { input });
}

export async function waitSession(
  sessionId: string
): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("wait_session", { sessionId });
}

export async function interruptSession(sessionId: string): Promise<EventRecord> {
  assertTauri();
  return invoke<EventRecord>("interrupt_session", { sessionId });
}

export async function continueSession(
  sessionId: string
): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("continue_session", { sessionId });
}

export async function recoverSessionFromCheckpoint(input: {
  sessionId: string;
  checkpointId?: string | null;
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("recover_session_from_checkpoint", {
    input
  });
}

export async function approveToolCall(eventId: string): Promise<EventRecord> {
  assertTauri();
  return invoke<EventRecord>("approve_tool_call", { eventId });
}

export async function rejectToolCall(eventId: string): Promise<EventRecord> {
  assertTauri();
  return invoke<EventRecord>("reject_tool_call", { eventId });
}

export async function replyPermission(input: {
  requestId: string;
  reply: PermissionReply;
}): Promise<PermissionRequestRecord> {
  assertTauri();
  return invoke<PermissionRequestRecord>("reply_permission", { input });
}

export async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  assertTauri();
  return invoke<Record<string, unknown>>("wait_job", { jobId });
}

export async function cancelJob(jobId: string): Promise<Record<string, unknown>> {
  assertTauri();
  return invoke<Record<string, unknown>>("cancel_job", { jobId });
}

export async function readJobLogs(jobId: string): Promise<Record<string, unknown>> {
  assertTauri();
  return invoke<Record<string, unknown>>("read_job_logs", { jobId });
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

export async function loadShellPolicy(): Promise<ShellPolicy> {
  assertTauri();
  return invoke<ShellPolicy>("load_shell_policy");
}

export async function saveShellPolicy(
  policy: ShellPolicy
): Promise<ShellPolicy> {
  assertTauri();
  return invoke<ShellPolicy>("save_shell_policy", { policy });
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
