import { create } from "zustand";
import type { EventRecord, SessionEventsResponse } from "./api";

export const EMPTY_SESSION_EVENTS: SessionEventsResponse = {
  events: [],
  snapshots: [],
  summaries: [],
  inputs: [],
  runs: [],
  permissions: [],
  jobs: []
};

export type ODotRealtimeEvent = {
  version: number;
  kind: string;
  sessionId: string;
  seq: number;
  event: EventRecord;
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
      eventsResponse: mergeEventRecord(state.eventsResponse, incoming.event)
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
    permissions: incoming.permissions ?? current.permissions,
    jobs: incoming.jobs ?? current.jobs
  };
}

function mergeEventRecord(
  current: SessionEventsResponse,
  incoming: EventRecord
): SessionEventsResponse {
  return mergeSessionEvents(current, {
    ...EMPTY_SESSION_EVENTS,
    events: [incoming]
  });
}
