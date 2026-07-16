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
  responsesBySessionId: Record<string, SessionEventsResponse>;
  setEventsResponse: (
    sessionId: string,
    next:
      | SessionEventsResponse
      | ((current: SessionEventsResponse) => SessionEventsResponse)
  ) => void;
  clearEvents: (sessionId?: string) => void;
  mergeEventsResponse: (sessionId: string, incoming: SessionEventsResponse) => void;
  applyRealtimeEvent: (incoming: ODotRealtimeEvent) => void;
};

export const useSessionEventStore = create<SessionEventState>((set) => ({
  responsesBySessionId: {},
  setEventsResponse: (sessionId, next) =>
    set((state) => ({
      responsesBySessionId: {
        ...state.responsesBySessionId,
        [sessionId]:
          typeof next === "function"
            ? next(state.responsesBySessionId[sessionId] ?? EMPTY_SESSION_EVENTS)
            : next
      }
    })),
  clearEvents: (sessionId) =>
    set((state) => ({
      responsesBySessionId: sessionId
        ? withoutSession(state.responsesBySessionId, sessionId)
        : {}
    })),
  mergeEventsResponse: (sessionId, incoming) =>
    set((state) => ({
      responsesBySessionId: {
        ...state.responsesBySessionId,
        [sessionId]: mergeSessionEvents(
          state.responsesBySessionId[sessionId] ?? EMPTY_SESSION_EVENTS,
          incoming
        )
      }
    })),
  applyRealtimeEvent: (incoming) =>
    set((state) => ({
      responsesBySessionId: {
        ...state.responsesBySessionId,
        [incoming.sessionId]: mergeRealtimeEvent(
          state.responsesBySessionId[incoming.sessionId] ?? EMPTY_SESSION_EVENTS,
          incoming
        )
      }
    }))
}));

export function currentSessionEvents(sessionId: string) {
  return (
    useSessionEventStore.getState().responsesBySessionId[sessionId] ??
    EMPTY_SESSION_EVENTS
  );
}

function withoutSession(
  responses: Record<string, SessionEventsResponse>,
  sessionId: string
) {
  const next = { ...responses };
  delete next[sessionId];
  return next;
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
    snapshots: mergeListById(current.snapshots, incoming.snapshots).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    ),
    summaries: mergeListById(current.summaries, incoming.summaries).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    ),
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
  const events = current.events;
  // Streaming deltas update the same (most-recent) event id many times per second,
  // so search from the end and update in place — avoiding rebuilding a Map and
  // re-sorting the whole array on every token.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].id === incoming.id) {
      const nextEvents = events.slice();
      nextEvents[index] = incoming;
      return { ...current, events: nextEvents };
    }
  }
  // New event: append directly when it belongs at (or after) the tail, which is the
  // common append case. Only fall back to a full sorted rebuild for the rare
  // out-of-order insert.
  const lastSeq = events.length ? events[events.length - 1].seq : Number.NEGATIVE_INFINITY;
  if (incoming.seq >= lastSeq) {
    return { ...current, events: [...events, incoming] };
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  byId.set(incoming.id, incoming);
  return {
    ...current,
    events: Array.from(byId.values()).sort((a, b) => a.seq - b.seq)
  };
}

function mergeListById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (!incoming.length) {
    return current;
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
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
