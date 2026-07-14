import type {
  FloatAgentStatusRecord,
  FloatAgentStatusKind,
  FloatPendingApproval
} from "./floatAgentStatus";
import type { PromptAttachmentKind } from "./promptAttachments";

export const AGENT_WINDOW_STORAGE_PREFIX = "odot.agentWindow:";
export const ACTIVE_AGENT_WINDOW_STORAGE_KEY = "odot.activeAgentWindow";
export const AGENT_WINDOW_HEARTBEAT_MAX_AGE_MS = 12_000;

export type AgentWindowRecord = {
  windowId: string;
  sessionId: string;
  projectRoot: string;
  title: string;
  status: FloatAgentStatusKind;
  statusLabel: string;
  allowedAttachmentKinds: PromptAttachmentKind[];
  message: string;
  pendingApproval: FloatPendingApproval | null;
  completedAt?: number;
  updatedAt: number;
  focusedAt: number;
  heartbeatAt: number;
};

type ActiveWindowRecord = {
  windowId: string;
  focusedAt: number;
};

export function isAgentWindowLabel(label: string) {
  return label === "main" || label.startsWith("agent-");
}

export function agentWindowStorageKey(windowId: string) {
  return `${AGENT_WINDOW_STORAGE_PREFIX}${encodeURIComponent(windowId)}`;
}

export function scopedStorageKey(baseKey: string, windowId: string) {
  return windowId === "main" ? baseKey : `${baseKey}:${encodeURIComponent(windowId)}`;
}

export function createAgentWindowRecord(input: {
  windowId: string;
  sessionId?: string;
  projectRoot?: string;
  title: string;
  status?: FloatAgentStatusRecord;
}): AgentWindowRecord {
  const now = Date.now();
  const status = input.status ?? idleStatus(input.sessionId ?? "", now);
  return {
    windowId: input.windowId,
    sessionId: input.sessionId ?? status.sessionId,
    projectRoot: input.projectRoot ?? "",
    title: input.title,
    status: status.kind,
    statusLabel: status.label,
    allowedAttachmentKinds: status.allowedAttachmentKinds,
    message: status.message ?? "",
    pendingApproval: status.pendingApproval ?? null,
    completedAt: status.completedAt,
    updatedAt: now,
    focusedAt: now,
    heartbeatAt: now
  };
}

export function writeAgentWindow(record: AgentWindowRecord) {
  localStorage.setItem(agentWindowStorageKey(record.windowId), JSON.stringify(record));
}

export function readAgentWindow(windowId: string): AgentWindowRecord | null {
  const raw = localStorage.getItem(agentWindowStorageKey(windowId));
  if (!raw) {
    return null;
  }
  try {
    return normalizeAgentWindow(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function updateAgentWindow(
  windowId: string,
  patch: Partial<AgentWindowRecord> & { statusRecord?: FloatAgentStatusRecord }
) {
  const current = readAgentWindow(windowId);
  if (!current) {
    return null;
  }
  const nextStatus = patch.statusRecord;
  const next: AgentWindowRecord = {
    ...current,
    ...patch,
    ...(nextStatus
      ? {
          status: nextStatus.kind,
          statusLabel: nextStatus.label,
          allowedAttachmentKinds: nextStatus.allowedAttachmentKinds,
          message: nextStatus.message ?? "",
          pendingApproval: nextStatus.pendingApproval ?? null,
          completedAt: nextStatus.completedAt,
          sessionId: nextStatus.sessionId || current.sessionId
        }
      : {}),
    updatedAt: Date.now(),
    heartbeatAt: Date.now()
  };
  delete (next as { statusRecord?: unknown }).statusRecord;
  writeAgentWindow(next);
  return next;
}

export function touchAgentWindow(windowId: string, focused = false) {
  const current = readAgentWindow(windowId);
  if (!current) {
    return null;
  }
  const now = Date.now();
  const next = {
    ...current,
    heartbeatAt: now,
    ...(focused ? { focusedAt: now } : {})
  };
  writeAgentWindow(next);
  if (focused) {
    setActiveAgentWindow(windowId, now);
  }
  return next;
}

export function removeAgentWindow(windowId: string) {
  localStorage.removeItem(agentWindowStorageKey(windowId));
  const active = readActiveWindowPointer();
  if (active?.windowId === windowId) {
    localStorage.removeItem(ACTIVE_AGENT_WINDOW_STORAGE_KEY);
  }
}

export function listAgentWindows(now = Date.now()): AgentWindowRecord[] {
  const records: AgentWindowRecord[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(AGENT_WINDOW_STORAGE_PREFIX)) {
      continue;
    }
    const windowId = decodeURIComponent(key.slice(AGENT_WINDOW_STORAGE_PREFIX.length));
    const record = readAgentWindow(windowId);
    if (record && now - record.heartbeatAt <= AGENT_WINDOW_HEARTBEAT_MAX_AGE_MS) {
      records.push(record);
    }
  }
  return records.sort((left, right) => right.focusedAt - left.focusedAt);
}

export function setActiveAgentWindow(windowId: string, focusedAt = Date.now()) {
  localStorage.setItem(
    ACTIVE_AGENT_WINDOW_STORAGE_KEY,
    JSON.stringify({ windowId, focusedAt } satisfies ActiveWindowRecord)
  );
}

export function getActiveAgentWindow(): AgentWindowRecord | null {
  const windows = listAgentWindows();
  if (!windows.length) {
    return null;
  }
  const pointer = readActiveWindowPointer();
  if (pointer) {
    const active = windows.find((record) => record.windowId === pointer.windowId);
    if (active) {
      return active;
    }
  }
  return windows[0];
}

export function agentWindowStatus(record: AgentWindowRecord): FloatAgentStatusRecord {
  return {
    kind: record.status,
    label: record.statusLabel || record.status,
    sessionId: record.sessionId,
    allowedAttachmentKinds: record.allowedAttachmentKinds,
    message: record.message,
    pendingApproval: record.pendingApproval,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt
  };
}

function readActiveWindowPointer(): ActiveWindowRecord | null {
  const raw = localStorage.getItem(ACTIVE_AGENT_WINDOW_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<ActiveWindowRecord>;
    if (typeof value.windowId !== "string" || typeof value.focusedAt !== "number") {
      return null;
    }
    return { windowId: value.windowId, focusedAt: value.focusedAt };
  } catch {
    return null;
  }
}

function normalizeAgentWindow(value: unknown): AgentWindowRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const windowId = stringValue(record.windowId);
  if (!windowId) {
    return null;
  }
  const status = isFloatAgentStatusKind(record.status) ? record.status : "idle";
  const updatedAt = numberValue(record.updatedAt);
  const focusedAt = numberValue(record.focusedAt) || updatedAt;
  const heartbeatAt = numberValue(record.heartbeatAt) || updatedAt;
  return {
    windowId,
    sessionId: stringValue(record.sessionId),
    projectRoot: stringValue(record.projectRoot),
    title: stringValue(record.title) || "新窗口",
    status,
    statusLabel: stringValue(record.statusLabel),
    allowedAttachmentKinds: normalizeAttachmentKinds(record.allowedAttachmentKinds),
    message: stringValue(record.message),
    pendingApproval: normalizePendingApproval(record.pendingApproval),
    completedAt: typeof record.completedAt === "number" ? record.completedAt : undefined,
    updatedAt,
    focusedAt,
    heartbeatAt
  };
}

function idleStatus(sessionId: string, updatedAt: number): FloatAgentStatusRecord {
  return {
    kind: "idle",
    label: "Agent idle",
    sessionId,
    allowedAttachmentKinds: [],
    message: "",
    pendingApproval: null,
    updatedAt
  };
}

function isFloatAgentStatusKind(value: unknown): value is FloatAgentStatusKind {
  return (
    value === "idle" ||
    value === "working" ||
    value === "thinking" ||
    value === "error" ||
    value === "approval" ||
    value === "complete"
  );
}

function normalizeAttachmentKinds(value: unknown): PromptAttachmentKind[] {
  return Array.isArray(value)
    ? value.filter((item): item is PromptAttachmentKind => item === "text" || item === "image")
    : [];
}

function normalizePendingApproval(value: unknown): FloatPendingApproval | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const eventId = stringValue(record.eventId);
  if (!eventId) {
    return null;
  }
  return {
    kind: record.kind === "permission" ? "permission" : "tool",
    eventId,
    command: stringValue(record.command)
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
