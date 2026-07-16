import { beforeEach, describe, expect, it } from "vitest";
import type {
  EventRecord,
  PermissionRequestRecord,
  SessionEventsResponse
} from "./api";
import {
  currentSessionEvents,
  EMPTY_SESSION_EVENTS,
  useSessionEventStore
} from "./sessionStore";

function event(sessionId: string, seq: number, type = "assistant.message"): EventRecord {
  return {
    id: `${sessionId}-${seq}`,
    sessionId,
    seq,
    type,
    data: { text: `${sessionId}:${seq}` },
    createdAt: `2026-01-01T00:00:0${seq}Z`
  };
}

function response(...events: EventRecord[]): SessionEventsResponse {
  return { ...EMPTY_SESSION_EVENTS, events };
}

function permission(
  sessionId: string,
  status: "pending" | "answered"
): PermissionRequestRecord {
  return {
    id: `${sessionId}-permission`,
    sessionId,
    action: "bash",
    resources: ["npm test"],
    save: ["npm test"],
    sourceJson: { type: "tool" },
    status,
    reply: status === "answered" ? "once" : null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: status === "answered" ? "2026-01-01T00:00:01Z" : "2026-01-01T00:00:00Z"
  };
}

describe("session event store", () => {
  beforeEach(() => {
    useSessionEventStore.getState().clearEvents();
  });

  it("keeps full responses isolated by session id", () => {
    const store = useSessionEventStore.getState();
    store.setEventsResponse("session-a", response(event("session-a", 1)));
    store.setEventsResponse("session-b", response(event("session-b", 1)));

    expect(currentSessionEvents("session-a").events.map((item) => item.sessionId)).toEqual([
      "session-a"
    ]);
    expect(currentSessionEvents("session-b").events.map((item) => item.sessionId)).toEqual([
      "session-b"
    ]);
  });

  it("routes realtime events only to their source session", () => {
    const store = useSessionEventStore.getState();
    store.setEventsResponse("session-a", response(event("session-a", 1)));
    const originalA = currentSessionEvents("session-a");

    store.applyRealtimeEvent({
      version: 1,
      kind: "assistant.message",
      sessionId: "session-b",
      seq: 2,
      event: event("session-b", 2)
    });

    expect(currentSessionEvents("session-a")).toBe(originalA);
    expect(currentSessionEvents("session-b").events.map((item) => item.id)).toEqual([
      "session-b-2"
    ]);
  });

  it("does not let a late response overwrite another session", () => {
    const store = useSessionEventStore.getState();
    store.setEventsResponse("session-b", response(event("session-b", 3)));
    store.setEventsResponse("session-a", response(event("session-a", 2)));

    expect(currentSessionEvents("session-b").events.at(-1)?.seq).toBe(3);
    expect(currentSessionEvents("session-a").events.at(-1)?.seq).toBe(2);
  });

  it("updates permission state in the source session only", () => {
    const store = useSessionEventStore.getState();
    store.applyRealtimeEvent({
      version: 1,
      kind: "permission.requested",
      sessionId: "session-a",
      seq: 0,
      permission: permission("session-a", "pending")
    });
    store.applyRealtimeEvent({
      version: 1,
      kind: "permission.answered",
      sessionId: "session-a",
      seq: 0,
      permission: permission("session-a", "answered")
    });

    expect(currentSessionEvents("session-a").permissions).toHaveLength(1);
    expect(currentSessionEvents("session-a").permissions[0]?.status).toBe("answered");
    expect(currentSessionEvents("session-b").permissions).toEqual([]);
  });

  it("clears one session without discarding the others", () => {
    const store = useSessionEventStore.getState();
    store.setEventsResponse("session-a", response(event("session-a", 1)));
    store.setEventsResponse("session-b", response(event("session-b", 1)));

    store.clearEvents("session-a");

    expect(currentSessionEvents("session-a")).toBe(EMPTY_SESSION_EVENTS);
    expect(currentSessionEvents("session-b").events).toHaveLength(1);
  });
});
