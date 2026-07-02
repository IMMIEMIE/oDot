export type PromptDraftSource = "main" | "float";

export type PromptDraftRecord = {
  text: string;
  source: PromptDraftSource;
  updatedAt: number;
};

export const PROMPT_DRAFT_STORAGE_KEY = "odot.promptDraft";

export function readPromptDraft(): PromptDraftRecord | null {
  try {
    const raw = localStorage.getItem(PROMPT_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<PromptDraftRecord>;
    if (typeof value.text !== "string") {
      return null;
    }
    return {
      text: value.text,
      source: value.source === "float" ? "float" : "main",
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
    };
  } catch {
    return null;
  }
}

export function savePromptDraft(text: string, source: PromptDraftSource) {
  localStorage.setItem(
    PROMPT_DRAFT_STORAGE_KEY,
    JSON.stringify({
      text,
      source,
      updatedAt: Date.now()
    } satisfies PromptDraftRecord)
  );
}

export function clearPromptDraft(source: PromptDraftSource) {
  savePromptDraft("", source);
}
