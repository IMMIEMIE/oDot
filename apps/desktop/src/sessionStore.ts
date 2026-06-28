import { create } from "zustand";
import type {
  BackgroundJobRecord,
  ContextSummaryRecord,
  EventRecord,
  PermissionRequestRecord,
  SnapshotRecord,
  SessionEventsResponse,
  TodoRecord
} from "./api";

export const EMPTY_SESSION_EVENTS: SessionEventsResponse = {
  events: [],
  snapshots: [],
  summaries: [],
  inputs: [],
  runs: [],
  checkpoints: [],
  permissions: [],
  jobs: [],
  todos: []
};

export type ODotRealtimeEvent = {
  version: number;
  kind: string;
  sessionId: string;
  seq: number;
  event?: EventRecord;
  permission?: PermissionRequestRecord;
  job?: BackgroundJobRecord;
  snapshot?: SnapshotRecord;
  summary?: ContextSummaryRecord;
};

type SessionEventState = {
  eventsResponse: SessionEventsResponse;
  setEventsResponse: (
    next:
      | SessionEventsResponse
      | ((current: SessionEventsResponse) => SessionEventsResponse)
  ) => void;
  clearEvents: () => void;
  mergeEventsResponse: (incoming: SessionEventsResponse) => void;
  applyRealtimeEvent: (incoming: ODotRealtimeEvent) => void;
};

export const useSessionEventStore = create<SessionEventState>((set) => ({
  eventsResponse: EMPTY_SESSION_EVENTS,
  setEventsResponse: (next) =>
    set((state) => ({
      eventsResponse:
        typeof next === "function" ? next(state.eventsResponse) : next
    })),
  clearEvents: () => set({ eventsResponse: EMPTY_SESSION_EVENTS }),
  mergeEventsResponse: (incoming) =>
    set((state) => ({
      eventsResponse: mergeSessionEvents(state.eventsResponse, incoming)
    })),
  applyRealtimeEvent: (incoming) =>
    set((state) => ({
      eventsResponse: mergeRealtimeEvent(state.eventsResponse, incoming)
    }))
}));

export function currentSessionEvents() {
  return useSessionEventStore.getState().eventsResponse;
}

export function mergeSessionEvents(
  current: SessionEventsResponse,
  incoming: SessionEventsResponse
): SessionEventsResponse {
  const byId = new Map(current.events.map((event) => [event.id, event]));
  for (const event of incoming.events) {
    byId.set(event.id, event);
  }
  return {
    events: Array.from(byId.values()).sort((a, b) => a.seq - b.seq),
    snapshots: incoming.snapshots.length ? incoming.snapshots : current.snapshots,
    summaries: incoming.summaries.length ? incoming.summaries : current.summaries,
    inputs: incoming.inputs ?? current.inputs,
    runs: incoming.runs ?? current.runs,
    checkpoints: incoming.checkpoints ?? current.checkpoints,
    permissions: incoming.permissions ?? current.permissions,
    jobs: incoming.jobs ?? current.jobs,
    todos: incoming.todos ?? current.todos
  };
}

function mergeEventRecord(
  current: SessionEventsResponse,
  incoming: EventRecord
): SessionEventsResponse {
  const byId = new Map(current.events.map((event) => [event.id, event]));
  byId.set(incoming.id, incoming);
  return {
    ...current,
    events: Array.from(byId.values()).sort((a, b) => a.seq - b.seq)
  };
}

function mergeRealtimeEvent(
  current: SessionEventsResponse,
  incoming: ODotRealtimeEvent
): SessionEventsResponse {
  let next = current;
  if (incoming.event) {
    next = mergeEventRecord(next, incoming.event);
    const todos = todosFromEvent(incoming.event);
    if (todos) {
      next = {
        ...next,
        todos
      };
    }
  }
  if (incoming.permission) {
    next = {
      ...next,
      permissions: mergeById(next.permissions, incoming.permission).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      )
    };
  }
  if (incoming.job) {
    next = {
      ...next,
      jobs: mergeById(next.jobs, incoming.job).sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt)
      )
    };
  }
  if (incoming.snapshot) {
    next = {
      ...next,
      snapshots: mergeById(next.snapshots, incoming.snapshot).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      )
    };
  }
  if (incoming.summary) {
    next = {
      ...next,
      summaries: mergeById(next.summaries, incoming.summary).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      )
    };
  }
  return next;
}

function todosFromEvent(event: EventRecord): TodoRecord[] | null {
  if (event.type !== "todo.updated" || !Array.isArray(event.data.todos)) {
    return null;
  }
  return event.data.todos
    .map((todo, position) => todoFromValue(todo, position))
    .filter((todo): todo is TodoRecord => Boolean(todo));
}

function todoFromValue(value: unknown, position: number): TodoRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content : "";
  const status = typeof record.status === "string" ? record.status : "pending";
  const priority = typeof record.priority === "string" ? record.priority : "medium";
  const itemPosition =
    typeof record.position === "number" && Number.isFinite(record.position)
      ? record.position
      : position;
  if (!content.trim()) {
    return null;
  }
  return { content, status, priority, position: itemPosition };
}

function mergeById<T extends { id: string }>(items: T[], incoming: T): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  byId.set(incoming.id, incoming);
  return Array.from(byId.values());
}
