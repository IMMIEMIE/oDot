import type { ExternalPromptReferencePayload } from "./api";
import type { PromptDraftSource } from "./promptDraft";

export type ExternalPromptReference = {
  id: string;
  source?: string | null;
  workspaceRoot?: string | null;
  itemType?: string | null;
  path?: string | null;
  absolutePath?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  language?: string | null;
};

export function externalPromptReferencesFromPayload(
  payload: ExternalPromptReferencePayload
): ExternalPromptReference[] {
  return (payload.items ?? []).flatMap((item) => {
    const absolutePath = item.absolutePath?.trim() || "";
    const itemPath = item.path?.trim() || "";
    if (!absolutePath && !itemPath) {
      return [];
    }
    const reference: ExternalPromptReference = {
      id: externalPromptReferenceId(payload, item),
      source: payload.source,
      workspaceRoot: payload.workspaceRoot,
      itemType: item.itemType,
      path: itemPath || null,
      absolutePath: absolutePath || null,
      startLine: item.startLine,
      endLine: item.endLine,
      language: item.language
    };
    return [reference];
  });
}

export function mergeExternalPromptReferences(
  current: ExternalPromptReference[],
  next: ExternalPromptReference[]
) {
  const byId = new Map(current.map((reference) => [reference.id, reference]));
  for (const reference of next) {
    byId.set(reference.id, reference);
  }
  return Array.from(byId.values());
}

export function selectedPathsToExternalReferences(
  selectedPaths: Iterable<string>,
  projectRoot?: string
): ExternalPromptReference[] {
  const root = projectRoot?.trim() || null;
  return Array.from(selectedPaths)
    .sort()
    .map((path): ExternalPromptReference => ({
      id: `path:${path}`,
      source: "odot",
      workspaceRoot: root,
      itemType: "file",
      path,
      absolutePath: null,
      startLine: null,
      endLine: null,
      language: null
    }));
}

export function mergePromptReferencesForStorage(
  externalReferences: ExternalPromptReference[],
  selectedPaths?: Iterable<string>,
  projectRoot?: string
): ExternalPromptReference[] {
  return mergeExternalPromptReferences(
    externalReferences,
    selectedPaths ? selectedPathsToExternalReferences(selectedPaths, projectRoot) : []
  );
}

export function resolvePromptReferencesFromStorage(
  viewerSource: PromptDraftSource,
  updatedAtRef: { current: number },
  fallback: ExternalPromptReference[]
): ExternalPromptReference[] {
  const draft = readPromptReferences();
  if (
    !draft ||
    draft.source === viewerSource ||
    draft.updatedAt <= updatedAtRef.current
  ) {
    return fallback;
  }
  updatedAtRef.current = draft.updatedAt;
  return draft.references;
}

export function externalPromptReferenceName(item: ExternalPromptReference) {
  const rawName = item.path || item.absolutePath || item.itemType || "external-reference";
  const baseName = rawName.split(/[\\/]/).filter(Boolean).at(-1) || rawName;
  return baseName;
}

export function externalPromptReferenceLineLabel(
  item: ExternalPromptReference,
  format: "display" | "plain" = "plain"
) {
  const prefix = format === "display" ? "L" : "";
  if (item.startLine && item.endLine && item.endLine !== item.startLine) {
    return `${prefix}${item.startLine}-${item.endLine}`;
  }
  if (item.startLine) {
    return `${prefix}${item.startLine}`;
  }
  return "";
}

export function externalPromptReferenceKind(reference: ExternalPromptReference) {
  if ((reference.itemType || "").toLowerCase().includes("dir")) {
    return "directory";
  }
  if (reference.startLine) {
    return "selection";
  }
  return "file";
}

export function externalPromptReferenceDisplayLabel(reference: ExternalPromptReference) {
  return [
    externalPromptReferenceName(reference),
    externalPromptReferenceLineLabel(reference, "display")
  ].filter(Boolean).join(" ");
}

export function formatExternalPromptReferences(references: ExternalPromptReference[]) {
  const lines = references
    .map((reference) => {
      const location = reference.absolutePath || reference.path || "";
      const lineLabel = externalPromptReferenceLineLabel(reference, "display");
      return [location, lineLabel].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  return lines.length ? `Referenced VS Code locations:\n${lines.join("\n")}` : "";
}

export function appendPromptReferenceSections(prompt: string, sections: string[]) {
  const cleanedSections = sections.map((section) => section.trim()).filter(Boolean);
  if (!cleanedSections.length) {
    return prompt;
  }
  return [prompt.trim(), ...cleanedSections].filter(Boolean).join("\n\n");
}

export const PROMPT_REFERENCES_STORAGE_KEY = "odot.promptReferences";

export type PromptReferencesDraftRecord = {
  references: ExternalPromptReference[];
  source: PromptDraftSource;
  updatedAt: number;
};

export function readPromptReferences(): PromptReferencesDraftRecord | null {
  try {
    const raw = localStorage.getItem(PROMPT_REFERENCES_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<PromptReferencesDraftRecord>;
    if (!Array.isArray(value.references)) {
      return null;
    }
    const references = value.references
      .map(normalizeExternalPromptReference)
      .filter((item): item is ExternalPromptReference => item !== null);
    return {
      references,
      source: value.source === "float" ? "float" : "main",
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
    };
  } catch {
    return null;
  }
}

export function savePromptReferences(
  references: ExternalPromptReference[],
  source: PromptDraftSource
) {
  localStorage.setItem(
    PROMPT_REFERENCES_STORAGE_KEY,
    JSON.stringify({
      references,
      source,
      updatedAt: Date.now()
    } satisfies PromptReferencesDraftRecord)
  );
}

export function referencesEqual(
  a: ExternalPromptReference[],
  b: ExternalPromptReference[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bIds = new Set(b.map((reference) => reference.id));
  return a.every((reference) => bIds.has(reference.id));
}

function normalizeExternalPromptReference(value: unknown): ExternalPromptReference | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const absolutePath = typeof record.absolutePath === "string" ? record.absolutePath : null;
  const path = typeof record.path === "string" ? record.path : null;
  if (!id || (!absolutePath && !path)) {
    return null;
  }
  return {
    id,
    source: typeof record.source === "string" ? record.source : null,
    workspaceRoot: typeof record.workspaceRoot === "string" ? record.workspaceRoot : null,
    itemType: typeof record.itemType === "string" ? record.itemType : null,
    path: path || null,
    absolutePath: absolutePath || null,
    startLine: typeof record.startLine === "number" ? record.startLine : null,
    endLine: typeof record.endLine === "number" ? record.endLine : null,
    language: typeof record.language === "string" ? record.language : null
  };
}

function externalPromptReferenceId(
  payload: ExternalPromptReferencePayload,
  item: ExternalPromptReferencePayload["items"][number]
) {
  return [
    payload.source || "external",
    item.absolutePath || item.path || "",
    item.startLine || "",
    item.endLine || "",
    item.itemType || ""
  ].join(":");
}
