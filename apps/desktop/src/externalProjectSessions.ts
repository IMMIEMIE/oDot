import type { ExternalProjectSessionsPayload } from "./api";
import type { PromptDraftSource } from "./promptDraft";

export const EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY = "odot.externalProjectSessions";

export type ExternalProjectSessionsDraftRecord = {
  payload: ExternalProjectSessionsPayload;
  source: PromptDraftSource;
  updatedAt: number;
};

export function readExternalProjectSessions(): ExternalProjectSessionsDraftRecord | null {
  const raw = localStorage.getItem(EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<ExternalProjectSessionsDraftRecord>;
    if (!value.payload || !Array.isArray(value.payload.sessions)) {
      return null;
    }
    return {
      payload: {
        protocolVersion: value.payload.protocolVersion ?? 2,
        requestId: value.payload.requestId ?? `legacy-${value.updatedAt ?? 0}`,
        action: value.payload.action ?? "choose",
        workspaceRoot: value.payload.workspaceRoot ?? "",
        source: value.payload.source ?? null,
        busyReason: value.payload.busyReason ?? null,
        activeSessionId: value.payload.activeSessionId ?? null,
        sessions: value.payload.sessions
      },
      source: value.source === "float" ? "float" : "main",
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
    };
  } catch {
    return null;
  }
}

export function saveExternalProjectSessions(
  payload: ExternalProjectSessionsPayload,
  source: PromptDraftSource
) {
  localStorage.setItem(
    EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY,
    JSON.stringify({
      payload,
      source,
      updatedAt: Date.now()
    } satisfies ExternalProjectSessionsDraftRecord)
  );
}

export function clearExternalProjectSessions(source: PromptDraftSource) {
  localStorage.setItem(
    EXTERNAL_PROJECT_SESSIONS_STORAGE_KEY,
    JSON.stringify({
      payload: {
        protocolVersion: 2,
        requestId: `clear-${Date.now()}`,
        action: "ignored",
        workspaceRoot: "",
        source: null,
        busyReason: null,
        activeSessionId: null,
        sessions: []
      },
      source,
      updatedAt: Date.now()
    } satisfies ExternalProjectSessionsDraftRecord)
  );
}
