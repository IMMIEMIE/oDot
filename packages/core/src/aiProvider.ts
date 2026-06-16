import { createHash, randomUUID } from "node:crypto";
import type {
  ChangePlan,
  FileContent,
  ProviderConfig,
  ProposedFileChange
} from "./types";
import { createUnifiedDiffPreview } from "./diffPreview";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type ModelChangeResponse = {
  summary?: unknown;
  files?: unknown;
};

export async function proposeCodeChange(
  provider: ProviderConfig,
  instruction: string,
  files: FileContent[]
): Promise<ChangePlan> {
  if (files.length === 0) {
    throw new Error("Select at least one file before asking for a code change.");
  }

  const rawResponse = await callOpenAICompatibleProvider(provider, instruction, files);
  const parsed = parseModelChangeResponse(rawResponse);
  const changes = buildProposedChanges(files, parsed);

  if (changes.length === 0) {
    throw new Error("The model did not return any file changes.");
  }

  return {
    id: randomUUID(),
    summary: parsed.summary,
    createdAt: new Date().toISOString(),
    provider: provider.name,
    model: provider.model,
    changes,
    rawResponse
  };
}

async function callOpenAICompatibleProvider(
  provider: ProviderConfig,
  instruction: string,
  files: FileContent[]
): Promise<string> {
  const endpoint = toChatCompletionsEndpoint(provider.baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (provider.apiKey?.trim()) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      temperature: provider.temperature ?? 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are oDot, a local code editing engine.",
            "Return strict JSON only. Do not wrap it in Markdown.",
            "The JSON schema is:",
            "{\"summary\":\"short change summary\",\"files\":[{\"path\":\"relative/path\",\"updatedContent\":\"complete updated file contents\"}]}",
            "Only edit files included by the user. Preserve unrelated code and formatting."
          ].join("\n")
        },
        {
          role: "user",
          content: buildUserPrompt(instruction, files)
        }
      ]
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | ChatCompletionResponse
    | null;

  if (!response.ok) {
    const message = payload?.error?.message ?? response.statusText;
    throw new Error(`Provider request failed: ${message}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Provider returned an empty response.");
  }

  return content;
}

function buildUserPrompt(instruction: string, files: FileContent[]): string {
  const fileBundle = files
    .map((file) =>
      [
        `--- FILE: ${file.path}`,
        file.content,
        `--- END FILE: ${file.path}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    "Task:",
    instruction,
    "",
    "Editable files:",
    fileBundle
  ].join("\n");
}

function parseModelChangeResponse(rawResponse: string): {
  summary: string;
  files: Array<{ path: string; updatedContent: string }>;
} {
  const jsonText = extractJsonObject(rawResponse);
  const parsed = JSON.parse(jsonText) as ModelChangeResponse;

  if (typeof parsed.summary !== "string") {
    throw new Error("Model response is missing a string summary.");
  }

  if (!Array.isArray(parsed.files)) {
    throw new Error("Model response is missing a files array.");
  }

  return {
    summary: parsed.summary,
    files: parsed.files.map((file) => {
      if (
        typeof file !== "object" ||
        file === null ||
        !("path" in file) ||
        !("updatedContent" in file) ||
        typeof file.path !== "string" ||
        typeof file.updatedContent !== "string"
      ) {
        throw new Error("Model returned an invalid file change.");
      }

      return {
        path: file.path,
        updatedContent: file.updatedContent
      };
    })
  };
}

function extractJsonObject(rawResponse: string): string {
  const trimmed = rawResponse.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model response did not contain a JSON object.");
  }

  return candidate.slice(firstBrace, lastBrace + 1);
}

function buildProposedChanges(
  originalFiles: FileContent[],
  parsed: { files: Array<{ path: string; updatedContent: string }> }
): ProposedFileChange[] {
  const originals = new Map(
    originalFiles.map((file) => [normalizeProjectPath(file.path), file])
  );
  const changes: ProposedFileChange[] = [];

  for (const file of parsed.files) {
    const normalizedPath = normalizeProjectPath(file.path);
    const original = originals.get(normalizedPath);

    if (!original) {
      throw new Error(`Model tried to edit an unselected file: ${file.path}`);
    }

    if (hashContent(original.content) === hashContent(file.updatedContent)) {
      continue;
    }

    changes.push({
      path: normalizedPath,
      originalContent: original.content,
      updatedContent: file.updatedContent,
      patch: createUnifiedDiffPreview(
        normalizedPath,
        original.content,
        file.updatedContent
      )
    });
  }

  return changes;
}

function toChatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function normalizeProjectPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
