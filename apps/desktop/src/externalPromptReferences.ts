import type { ExternalPromptReferencePayload } from "./api";

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
