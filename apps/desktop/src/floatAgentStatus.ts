import type {
  EventRecord,
  PermissionRequestRecord,
  SessionEventsResponse,
  SessionRecord
} from "./api";
import { appT } from "./i18n";
import type { PromptAttachmentKind } from "./promptAttachments";

export const FLOAT_AGENT_STATUS_STORAGE_KEY = "odot.floatAgentStatus";
export const COMPLETE_TO_IDLE_DELAY_MS = 45_000;

export type FloatAgentStatusKind =
  | "idle"
  | "working"
  | "thinking"
  | "error"
  | "approval"
  | "complete";

export type FloatAgentStatusRecord = {
  kind: FloatAgentStatusKind;
  label: string;
  sessionId: string;
  allowedAttachmentKinds: PromptAttachmentKind[];
  message?: string;
  pendingApproval?: FloatPendingApproval | null;
  completedAt?: number;
  updatedAt: number;
};

export type FloatPendingApproval = {
  kind: "tool" | "permission";
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
  const pendingPermissionApproval = pendingPermissionRequest(eventsResponse.permissions);

  if (session.status === "failed" || statusEventIsFailure(latestStatus)) {
    return floatAgentStatus("error", appT("floatStatus.error"), sessionId, allowedAttachmentKinds);
  }

  if (currentPendingApproval || pendingPermissionApproval) {
    return floatAgentStatus(
      "approval",
      appT("floatStatus.waitingApproval"),
      sessionId,
      allowedAttachmentKinds,
      currentPendingApproval ?? pendingPermissionApproval
    );
  }

  if (isWorking) {
    const currentRunEvents = eventsSinceLatestPrompt(eventsResponse.events);
    const latestReasoningMessage = latestReasoningText(currentRunEvents);
    if (latestModelOutputIsReasoning(currentRunEvents)) {
      return floatAgentStatus(
        "thinking",
        appT("floatStatus.thinking"),
        sessionId,
        allowedAttachmentKinds,
        null,
        latestReasoningMessage
      );
    }
    const latestAssistantMessage = latestAssistantText(currentRunEvents);
    return floatAgentStatus(
      "working",
      appT("floatStatus.working"),
      sessionId,
      allowedAttachmentKinds,
      null,
      latestAssistantMessage
    );
  }

  const latestAssistantMessage = latestAssistantText(eventsResponse.events);
  if (statusEventIsComplete(latestStatus)) {
    return floatAgentStatus(
      "complete",
      appT("floatStatus.complete"),
      sessionId,
      allowedAttachmentKinds,
      null,
      latestAssistantMessage,
      eventTimestampMs(latestStatus)
    );
  }

  if (session.status === "completed") {
    return floatAgentStatus(
      "complete",
      appT("floatStatus.complete"),
      sessionId,
      allowedAttachmentKinds,
      null,
      latestAssistantMessage,
      eventTimestampMs(latestStatus) ?? timestampMs(session.updatedAt)
    );
  }

  return floatAgentStatus("idle", appT("floatStatus.idle"), sessionId, allowedAttachmentKinds);
}

export function saveFloatAgentStatus(status: FloatAgentStatusRecord) {
  localStorage.setItem(FLOAT_AGENT_STATUS_STORAGE_KEY, JSON.stringify(status));
}

export function mergeFloatAgentStatusForStorage(
  previous: FloatAgentStatusRecord,
  next: FloatAgentStatusRecord
): FloatAgentStatusRecord {
  if (next.kind !== "complete") {
    return { ...next, completedAt: undefined };
  }
  const completedAt =
    next.completedAt ??
    (previous.sessionId === next.sessionId && previous.completedAt
      ? previous.completedAt
      : Date.now());
  return { ...next, completedAt };
}

export function resolveFloatAgentStatusExpiry(
  status: FloatAgentStatusRecord,
  now = Date.now()
): FloatAgentStatusRecord {
  if (status.kind !== "complete") {
    return status;
  }
  const completedAt = status.completedAt ?? status.updatedAt;
  if (now - completedAt < COMPLETE_TO_IDLE_DELAY_MS) {
    return status.completedAt === completedAt ? status : { ...status, completedAt };
  }
  return {
    kind: "idle",
    label: appT("floatStatus.idle"),
    sessionId: status.sessionId,
    allowedAttachmentKinds: status.allowedAttachmentKinds,
    message: "",
    pendingApproval: null,
    completedAt,
    updatedAt: now
  };
}

export function persistFloatAgentStatus(
  previous: FloatAgentStatusRecord,
  next: FloatAgentStatusRecord
): FloatAgentStatusRecord {
  const resolved = resolveFloatAgentStatusExpiry(
    mergeFloatAgentStatusForStorage(previous, next)
  );
  saveFloatAgentStatus(resolved);
  return resolved;
}

export function loadFloatAgentStatus(): FloatAgentStatusRecord {
  const raw = localStorage.getItem(FLOAT_AGENT_STATUS_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_FLOAT_AGENT_STATUS;
  }
  try {
    return resolveFloatAgentStatusExpiry(normalizeFloatAgentStatus(JSON.parse(raw)));
  } catch {
    return DEFAULT_FLOAT_AGENT_STATUS;
  }
}

function floatAgentStatus(
  kind: FloatAgentStatusKind,
  label: string,
  sessionId: string,
  allowedAttachmentKinds: PromptAttachmentKind[],
  pendingApproval: FloatPendingApproval | null = null,
  message = "",
  completedAt?: number
): FloatAgentStatusRecord {
  return {
    kind,
    label,
    sessionId,
    allowedAttachmentKinds,
    message,
    pendingApproval,
    completedAt,
    updatedAt: Date.now()
  };
}

function eventTimestampMs(event: EventRecord | undefined) {
  return timestampMs(event?.createdAt);
}

function timestampMs(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    kind: "tool",
    eventId: event.id,
    command: pendingCommand(event)
  };
}

function pendingPermissionRequest(permissions: PermissionRequestRecord[]): FloatPendingApproval | null {
  const request = permissions.find(
    (permission) => permission.status === "pending" && !isToolPermissionRequest(permission)
  );
  if (!request) {
    return null;
  }
  return {
    kind: "permission",
    eventId: request.id,
    command: permissionCommand(request)
  };
}

function isToolPermissionRequest(permission: PermissionRequestRecord) {
  const source = asRecord(permission.sourceJson);
  return source.type === "tool";
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

export function looksLikeMarkdownDocument(text: string): boolean {
  const trimmed = cleanModelText(text);
  if (!trimmed) {
    return false;
  }
  return (
    /^#{1,6}\s+\S/m.test(trimmed) ||
    /```[\s\S]*?```/.test(trimmed) ||
    /^\s*[-*+]\s+\S/m.test(trimmed) ||
    /^\s*\d+\.\s+\S/m.test(trimmed) ||
    /\[[^\]]+\]\([^)]+\)/.test(trimmed) ||
    /^\|.+\|.+\|$/m.test(trimmed)
  );
}

export function isStaleCompletedReply(message: string, previousMessage: string): boolean {
  const live = message.trim();
  const previous = previousMessage.trim();
  if (!live || !previous) {
    return false;
  }
  if (live === previous) {
    return true;
  }
  const prefixLength = Math.min(live.length, previous.length, 240);
  if (prefixLength >= 32 && live.slice(0, prefixLength) === previous.slice(0, prefixLength)) {
    return true;
  }
  return looksLikeMarkdownDocument(live) && looksLikeMarkdownDocument(previous);
}

function eventsSinceLatestPrompt(events: EventRecord[]) {
  const latestPrompt = [...events]
    .reverse()
    .find((event) => event.type === "prompt.submitted");
  if (!latestPrompt) {
    return events;
  }
  return events.filter((event) => event.seq > latestPrompt.seq);
}

function latestModelOutputIsReasoning(events: EventRecord[]) {
  const latest = [...events].reverse().find((event) =>
    [
      "assistant.message",
      "assistant.message.delta",
      "reasoning.summary",
      "reasoning.summary.delta"
    ].includes(event.type)
  );
  return latest?.type === "reasoning.summary" || latest?.type === "reasoning.summary.delta";
}

function latestAssistantText(events: EventRecord[]) {
  return markdownMessagePreview(latestStreamText(events, "assistant.message", "assistant.message.delta"));
}

function latestReasoningText(events: EventRecord[]) {
  return compactMessagePreview(latestStreamText(events, "reasoning.summary", "reasoning.summary.delta"));
}

function latestStreamText(events: EventRecord[], finalType: string, deltaType: string) {
  const finalEvent = [...events].reverse().find((item) => item.type === finalType);
  if (finalEvent) {
    return valueAsString(finalEvent.data.text);
  }
  const latestDelta = [...events].reverse().find((item) => item.type === deltaType);
  if (!latestDelta) {
    return "";
  }
  const step = Number(latestDelta.data.step ?? 0);
  if (!Number.isFinite(step) || step <= 0) {
    return valueAsString(latestDelta.data.text);
  }
  return events
    .filter((item) => item.type === deltaType && Number(item.data.step ?? 0) === step)
    .map((item) => valueAsString(item.data.text))
    .join("");
}

function markdownMessagePreview(value: string) {
  const cleaned = cleanModelText(value);
  if (cleaned.length <= 1200) {
    return cleaned;
  }
  return `${cleaned.slice(0, 1197).trimEnd()}...`;
}

function compactMessagePreview(value: string) {
  const cleaned = cleanModelText(value)
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 260) {
    return cleaned;
  }
  return `${cleaned.slice(0, 257).trimEnd()}...`;
}

function cleanModelText(value: string) {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function normalizeFloatAgentStatus(value: unknown): FloatAgentStatusRecord {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const kind = record.kind;
  if (
    kind !== "idle" &&
    kind !== "working" &&
    kind !== "thinking" &&
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
    message: valueAsString(record.message),
    pendingApproval: normalizePendingApproval(record.pendingApproval),
    completedAt:
      typeof record.completedAt === "number" ? record.completedAt : undefined,
    updatedAt:
      typeof record.updatedAt === "number"
        ? record.updatedAt
        : DEFAULT_FLOAT_AGENT_STATUS.updatedAt
  };
}

function pendingCommand(event: EventRecord) {
  const pending = asRecord(event.data.pending);
  const questions = Array.isArray(pending.questions) ? pending.questions : [];
  const firstQuestion = questions.length ? asRecord(questions[0]) : {};
  return (
    valueAsString(pending.command) ||
    valueAsString(firstQuestion.question) ||
    valueAsString(pending.question) ||
    valueAsString(pending.reason) ||
    valueAsString(event.data.command) ||
    appT("event.pendingCommand")
  );
}

function permissionCommand(permission: PermissionRequestRecord) {
  const resources = permission.resources
    .map((resource) => resource.trim())
    .filter(Boolean)
    .join(", ");
  return resources ? `${permission.action}: ${resources}` : permission.action;
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
    kind: record.kind === "permission" ? "permission" : "tool",
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
