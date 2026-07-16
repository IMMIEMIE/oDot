import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { appT } from "./i18n";

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
  configPath?: string | null;
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

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelReasoningEffortsResponse = {
  efforts: ReasoningEffort[];
  current?: ReasoningEffort | null;
};

export type PromptAttachmentInput = {
  name: string;
  mime: string;
  size: number;
  kind: "text" | "image";
  content: string;
};

export type LoadedSkill = {
  name: string;
  path: string;
};

export type SkillRecord = {
  name: string;
  description: string;
  path: string;
};

export type McpServerConfig = {
  id: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  timeoutSeconds: number;
  requireApproval: boolean;
  readOnly: boolean;
};

export type McpToolDefinition = {
  serverId: string;
  name: string;
  displayName: string;
  description: string;
  inputSchema: unknown;
  requireApproval: boolean;
  readOnly: boolean;
};

export type ProjectCapabilityError = {
  source: string;
  message: string;
};

export type ProjectCapabilities = {
  configPath: string;
  skills: SkillRecord[];
  mcpServers: McpServerConfig[];
  mcpTools: McpToolDefinition[];
  errors: ProjectCapabilityError[];
};

export type McpConfigFileResponse = {
  path: string;
  content: string;
  mcpServers: McpServerConfig[];
};

export type CreateSessionInput = {
  projectRoot: string;
  mode: AgentMode;
  providerId: string;
  shellMode: ShellMode;
  configPath?: string | null;
  title?: string;
  parentSessionId?: string | null;
};

export type SessionRecord = {
  id: string;
  parentSessionId?: string | null;
  projectRoot: string;
  mode: AgentMode;
  providerId: string;
  configPath?: string | null;
  title: string;
  status: string;
  shellMode: ShellMode;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceResolutionAction =
  | "ignored"
  | "selected"
  | "created"
  | "choose"
  | "deferredBusy"
  | "needsSetup"
  | "error";

export type ExternalProjectSessionsPayload = {
  protocolVersion: number;
  requestId: string;
  action: WorkspaceResolutionAction;
  workspaceRoot: string;
  source?: string | null;
  busyReason?: string | null;
  activeSessionId?: string | null;
  sessions: SessionRecord[];
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
  loadedSkills: LoadedSkill[];
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

export type TodoRecord = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority: "high" | "medium" | "low" | string;
  position: number;
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
  todos: TodoRecord[];
};

export type ProjectFile = {
  path: string;
  size: number;
  modifiedAt: string;
  language: string;
};

export type BridgeStatus = {
  enabled: boolean;
  protocolVersion: number;
  host: string;
  port: number;
  configuredPort: number;
  portSource: string;
  settingsPath?: string | null;
  discoveryPath?: string | null;
  error?: string | null;
  restartRequired: boolean;
};

export type BridgeClient = {
  clientId: string;
  workspaceRoot?: string | null;
  workspaceName?: string | null;
  source?: string | null;
  focused: boolean;
  lastSeen: number;
  online: boolean;
};

export type ExternalPromptReferenceItem = {
  itemType?: string | null;
  path?: string | null;
  absolutePath?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  language?: string | null;
  content?: string | null;
};

export type ExternalPromptReferencePayload = {
  workspaceRoot?: string | null;
  source?: string | null;
  mode?: string | null;
  items: ExternalPromptReferenceItem[];
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
  projectRoot?: string,
  configPath?: string | null
): Promise<ProviderConfigFileResponse> {
  assertTauri();
  return invoke<ProviderConfigFileResponse>("load_provider_config", {
    projectRoot: projectRoot?.trim() || null,
    configPath: configPath?.trim() || null
  });
}

export async function saveProviderConfig(
  content: string,
  projectRoot?: string,
  configPath?: string | null
): Promise<ProviderConfigFileResponse> {
  assertTauri();
  return invoke<ProviderConfigFileResponse>("save_provider_config", {
    content,
    projectRoot: projectRoot?.trim() || null,
    configPath: configPath?.trim() || null
  });
}

export async function revealProviderConfig(path: string): Promise<void> {
  assertTauri();
  return invoke<void>("reveal_provider_config", { path });
}

export async function getModelReasoningEfforts(
  content: string,
  providerId: string,
  modelId: string
): Promise<ModelReasoningEffortsResponse> {
  assertTauri();
  return invoke<ModelReasoningEffortsResponse>("get_model_reasoning_efforts", {
    content,
    providerId,
    modelId
  });
}

export async function findOpencodeConfig(
  projectRoot?: string
): Promise<string | null> {
  assertTauri();
  return invoke<string | null>("find_opencode_config", {
    projectRoot: projectRoot?.trim() || null
  });
}

export async function listProjectCapabilities(
  projectRoot: string,
  configPath?: string | null
): Promise<ProjectCapabilities> {
  assertTauri();
  return invoke<ProjectCapabilities>("list_project_capabilities", {
    projectRoot,
    configPath: configPath?.trim() || null
  });
}

export async function saveMcpServer(
  projectRoot: string,
  server: McpServerConfig,
  configPath?: string | null
): Promise<McpConfigFileResponse> {
  assertTauri();
  return invoke<McpConfigFileResponse>("save_mcp_server", {
    projectRoot,
    configPath: configPath?.trim() || null,
    server
  });
}

export async function deleteMcpServer(
  projectRoot: string,
  serverId: string,
  configPath?: string | null
): Promise<McpConfigFileResponse> {
  assertTauri();
  return invoke<McpConfigFileResponse>("delete_mcp_server", {
    projectRoot,
    configPath: configPath?.trim() || null,
    serverId
  });
}

export async function testMcpConnection(
  projectRoot: string,
  server: McpServerConfig
): Promise<McpToolDefinition[]> {
  assertTauri();
  return invoke<McpToolDefinition[]>("test_mcp_connection", {
    projectRoot,
    server
  });
}

export async function importSkill(
  projectRoot: string,
  sourcePath: string
): Promise<SkillRecord> {
  assertTauri();
  return invoke<SkillRecord>("import_skill", {
    projectRoot,
    sourcePath
  });
}

export async function deleteSkill(
  projectRoot: string,
  skillPath: string
): Promise<void> {
  assertTauri();
  return invoke<void>("delete_skill", {
    projectRoot,
    skillPath
  });
}

export async function pickSkillFile(): Promise<string | null> {
  assertTauri();
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md"] }],
    title: appT("api.pickSkillTitle")
  });
  return typeof selected === "string" ? selected : null;
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

export async function getSession(sessionId: string): Promise<SessionRecord> {
  assertTauri();
  return invoke<SessionRecord>("get_session", { sessionId });
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

export async function renameSession(input: {
  sessionId: string;
  title: string;
}): Promise<SessionRecord> {
  assertTauri();
  return invoke<SessionRecord>("rename_session", { input });
}

export async function updateSessionMode(input: {
  sessionId: string;
  mode?: AgentMode;
  shellMode?: ShellMode;
  providerId?: string;
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
  loadedSkills?: LoadedSkill[];
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("submit_prompt", { input });
}

export async function promptSession(input: {
  id?: string;
  sessionId: string;
  prompt: string;
  attachments?: PromptAttachmentInput[];
  loadedSkills?: LoadedSkill[];
  delivery?: SessionInputDelivery;
  resume?: boolean;
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("prompt_session", { input });
}

export async function deleteQueuedInput(
  inputId: string
): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("delete_queued_input", { inputId });
}

export async function recoverBackgroundTask(input: {
  jobId: string;
  action: "resumeChild" | "abandon";
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("recover_background_task", { input });
}

export async function persistPlanFile(input: {
  sessionId: string;
  planText: string;
}): Promise<string> {
  assertTauri();
  return invoke<string>("persist_plan_file", { input });
}

export async function revealProjectPath(input: {
  sessionId: string;
  path: string;
}): Promise<void> {
  assertTauri();
  return invoke<void>("reveal_project_path", { input });
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

export async function awaitSessionIdle(
  sessionId: string
): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("await_session_idle", { sessionId });
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

export async function promoteTask(input: {
  sessionId: string;
  taskSessionId: string;
}): Promise<SessionEventsResponse> {
  assertTauri();
  return invoke<SessionEventsResponse>("promote_task", {
    sessionId: input.sessionId,
    taskSessionId: input.taskSessionId
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

export async function getBridgeStatus(): Promise<BridgeStatus> {
  assertTauri();
  return invoke<BridgeStatus>("get_bridge_status");
}

export async function getBridgeClients(): Promise<BridgeClient[]> {
  assertTauri();
  return invoke<BridgeClient[]>("get_bridge_clients");
}

export async function setBridgePort(port: number): Promise<BridgeStatus> {
  assertTauri();
  return invoke<BridgeStatus>("set_bridge_port", { port });
}

export async function reportWorkspaceResolution(input: {
  action: WorkspaceResolutionAction;
  workspaceRoot: string;
  activeSessionId?: string | null;
  busyReason?: string | null;
}): Promise<ExternalProjectSessionsPayload> {
  assertTauri();
  return invoke<ExternalProjectSessionsPayload>("report_workspace_resolution", {
    action: input.action,
    workspaceRoot: input.workspaceRoot,
    activeSessionId: input.activeSessionId ?? null,
    busyReason: input.busyReason ?? null
  });
}

export async function quitApp(): Promise<void> {
  assertTauri();
  return invoke<void>("quit_app");
}

export async function pickProjectDirectory(): Promise<string | null> {
  assertTauri();
  const selected = await open({
    directory: true,
    multiple: false,
    title: appT("api.pickProjectTitle")
  });

  return typeof selected === "string" ? selected : null;
}

export async function pickProviderConfigFile(): Promise<string | null> {
  assertTauri();
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
    title: appT("api.pickConfigTitle")
  });

  return typeof selected === "string" ? selected : null;
}

function assertTauri() {
  if (!isTauri()) {
    throw new Error(appT("api.tauriOnly"));
  }
}
