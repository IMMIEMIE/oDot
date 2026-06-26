import type {
  EventRecord,
  PermissionRequestRecord,
  SessionEventsResponse,
  SessionRecord
} from "./api";
import { appT } from "./i18n";
import type { PromptAttachmentKind } from "./promptAttachments";

export const FLOAT_AGENT_STATUS_STORAGE_KEY = "odot.floatAgentStatus";

export type FloatAgentStatusKind = "idle" | "working" | "error" | "approval" | "complete";

export type FloatAgentStatusRecord = {
  kind: FloatAgentStatusKind;
  label: string;
  sessionId: string;
  allowedAttachmentKinds: PromptAttachmentKind[];
  pendingApproval?: FloatPendingApproval | null;
  updatedAt: number;
};

export type FloatPendingApproval = {
  eventId: string;
  command: string;
};

export const DEFAULT_FLOAT_AGENT_STATUS: FloatAgentStatusRecord = {
  kind: "idle",
  label: appT("floatStatus.idle"),
  sessionId: "",
  allowedAttachmentKinds: [],
  pendingApproval: null,
  updatedAt: 0
};

type FloatAgentStatusInput = {
  session: SessionRecord | null | undefined;
  eventsResponse: SessionEventsResponse;
  isWorking: boolean;
  allowedAttachmentKinds: PromptAttachmentKind[];
};

export function deriveFloatAgentStatus({
  session,
  eventsResponse,
  isWorking,
  allowedAttachmentKinds
}: FloatAgentStatusInput): FloatAgentStatusRecord {
  const sessionId = session?.id ?? "";
  if (!session) {
    return floatAgentStatus("idle", appT("floatStatus.idle"), sessionId, allowedAttachmentKinds);
  }

  const latestStatus = latestStatusEvent(eventsResponse.events);
  const pendingApproval = unresolvedPendingTool(eventsResponse.events);
  const pendingApprovalIsCurrent = pendingApproval
    ? isPendingApprovalCurrent(eventsResponse.events, pendingApproval.eventId, latestStatus)
    : false;
  const currentPendingApproval = pendingApprovalIsCurrent ? pendingApproval : null;
  const hasPendingPermissionRequest = hasPendingPermission(eventsResponse.permissions);

  if (session.status === "failed" || statusEventIsFailure(latestStatus)) {
    return floatAgentStatus("error", appT("floatStatus.error"), sessionId, allowedAttachmentKinds);
  }

  if (isWorking) {
    return floatAgentStatus("working", appT("floatStatus.working"), sessionId, allowedAttachmentKinds);
  }

  if (statusEventIsComplete(latestStatus)) {
    return floatAgentStatus("complete", appT("floatStatus.complete"), sessionId, allowedAttachmentKinds);
  }

  if (currentPendingApproval || hasPendingPermissionRequest) {
    return floatAgentStatus(
      "approval",
      appT("floatStatus.waitingApproval"),
      sessionId,
      allowedAttachmentKinds,
      currentPendingApproval
    );
  }

  if (session.status === "completed") {
    return floatAgentStatus("complete", appT("floatStatus.complete"), sessionId, allowedAttachmentKinds);
  }

  return floatAgentStatus("idle", appT("floatStatus.idle"), sessionId, allowedAttachmentKinds);
}

export function saveFloatAgentStatus(status: FloatAgentStatusRecord) {
  localStorage.setItem(FLOAT_AGENT_STATUS_STORAGE_KEY, JSON.stringify(status));
}

export function loadFloatAgentStatus(): FloatAgentStatusRecord {
  const raw = localStorage.getItem(FLOAT_AGENT_STATUS_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_FLOAT_AGENT_STATUS;
  }
  try {
    return normalizeFloatAgentStatus(JSON.parse(raw));
  } catch {
    return DEFAULT_FLOAT_AGENT_STATUS;
  }
}

function floatAgentStatus(
  kind: FloatAgentStatusKind,
  label: string,
  sessionId: string,
  allowedAttachmentKinds: PromptAttachmentKind[],
  pendingApproval: FloatPendingApproval | null = null
): FloatAgentStatusRecord {
  return {
    kind,
    label,
    sessionId,
    allowedAttachmentKinds,
    pendingApproval,
    updatedAt: Date.now()
  };
}

function unresolvedPendingTool(events: EventRecord[]): FloatPendingApproval | null {
  const resolved = new Set(
    events
      .map((event) => valueAsString(event.data.pendingEventId))
      .filter(Boolean)
  );
  const event = [...events].reverse().find(
    (item) =>
      item.type === "tool.pending" &&
      isApprovalTool(item) &&
      !resolved.has(item.id)
  );
  if (!event) {
    return null;
  }
  return {
    eventId: event.id,
    command: pendingCommand(event)
  };
}

function hasPendingPermission(permissions: PermissionRequestRecord[]) {
  return permissions.some((permission) => permission.status === "pending");
}

function isPendingApprovalCurrent(
  events: EventRecord[],
  pendingEventId: string,
  latestStatus: EventRecord | undefined
) {
  const pending = events.find((event) => event.id === pendingEventId);
  if (!pending) {
    return false;
  }
  if (!latestStatus) {
    return true;
  }
  if (latestStatus.type === "step.ended" && latestStatus.data.pending === true) {
    return true;
  }
  return pending.seq > latestStatus.seq;
}

function statusEventIsFailure(latest: EventRecord | undefined) {
  return Boolean(
    latest &&
      (latest.type === "agent.failed" ||
        latest.type === "step.failed" ||
        latest.type === "policy.blocked")
  );
}

function statusEventIsComplete(latest: EventRecord | undefined) {
  return Boolean(
    latest &&
      (latest.type === "agent.stopped" ||
        latest.type === "task.completed" ||
        (latest.type === "step.ended" && latest.data.done === true && latest.data.pending !== true))
  );
}

function latestStatusEvent(events: EventRecord[]) {
  return [...events].reverse().find((event) =>
    [
      "agent.failed",
      "agent.stopped",
      "policy.blocked",
      "step.failed",
      "step.ended",
      "task.completed"
    ].includes(event.type)
  );
}

function normalizeFloatAgentStatus(value: unknown): FloatAgentStatusRecord {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const kind = record.kind;
  if (
    kind !== "idle" &&
    kind !== "working" &&
    kind !== "error" &&
    kind !== "approval" &&
    kind !== "complete"
  ) {
    return DEFAULT_FLOAT_AGENT_STATUS;
  }
  return {
    kind,
    label: valueAsString(record.label) || DEFAULT_FLOAT_AGENT_STATUS.label,
    sessionId: valueAsString(record.sessionId),
    allowedAttachmentKinds: normalizeAttachmentKinds(record.allowedAttachmentKinds),
    pendingApproval: normalizePendingApproval(record.pendingApproval),
    updatedAt:
      typeof record.updatedAt === "number"
        ? record.updatedAt
        : DEFAULT_FLOAT_AGENT_STATUS.updatedAt
  };
}

function pendingCommand(event: EventRecord) {
  const pending = asRecord(event.data.pending);
  return (
    valueAsString(pending.command) ||
    valueAsString(event.data.command) ||
    appT("event.pendingCommand")
  );
}

function isApprovalTool(event: EventRecord) {
  const name = valueAsString(event.data.name).toLowerCase();
  return name === "shell" || name === "bash";
}

function normalizeAttachmentKinds(value: unknown): PromptAttachmentKind[] {
  return Array.isArray(value)
    ? value.filter((item): item is PromptAttachmentKind => item === "text" || item === "image")
    : [];
}

function normalizePendingApproval(value: unknown): FloatPendingApproval | null {
  const record = asRecord(value);
  const eventId = valueAsString(record.eventId);
  if (!eventId) {
    return null;
  }
  return {
    eventId,
    command: valueAsString(record.command) || appT("event.pendingCommand")
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown) {
  return typeof value === "string" ? value : "";
}
