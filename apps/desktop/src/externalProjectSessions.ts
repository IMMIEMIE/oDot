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
        workspaceRoot: value.payload.workspaceRoot ?? null,
        source: value.payload.source ?? null,
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
      payload: { workspaceRoot: null, source: null, sessions: [] },
      source,
      updatedAt: Date.now()
    } satisfies ExternalProjectSessionsDraftRecord)
  );
}
