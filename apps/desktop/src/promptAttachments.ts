import type { PromptAttachmentInput } from "./api";

export const MAX_TEXT_ATTACHMENT_BYTES = 250_000;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type PromptAttachmentKind = "text" | "image";

export type PromptAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: PromptAttachmentKind;
  content: string;
};

export function clipboardFiles(data: DataTransfer): File[] {
  const byKey = new Map<string, File>();
  for (const file of Array.from(data.files)) {
    byKey.set(`${file.name}:${file.size}:${file.type}`, file);
  }
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    byKey.set(`${file.name}:${file.size}:${file.type}`, file);
  }
  return Array.from(byKey.values());
}

export async function readPromptAttachment(
  file: File,
  allowedKinds: PromptAttachmentKind[]
): Promise<PromptAttachment> {
  const kind = promptAttachmentKindForFile(file, allowedKinds);
  if (!kind) {
    throw new Error(`当前模型不支持该附件类型：${file.name}`);
  }
  if (kind === "text" && file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(`文本附件过大：${file.name}，最大 ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}。`);
  }
  if (kind === "image" && file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`图片附件过大：${file.name}，最大 ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}。`);
  }

  const mime = attachmentMimeForFile(file, kind);
  return {
    id: newId(),
    name: file.name,
    mime,
    size: file.size,
    kind,
    content: kind === "image" ? await readFileAsDataUrl(file, mime) : await readFileAsText(file)
  };
}

export function toPromptAttachmentInput(
  attachment: PromptAttachment
): PromptAttachmentInput {
  return {
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    kind: attachment.kind,
    content: attachment.content
  };
}

export function shellAllowlistPrefix(command: string) {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  const first = normalized.split(" ")[0] ?? normalized;
  if (first === "cd") {
    return "cd";
  }
  if (first === "npm" || first === "pnpm" || first === "yarn") {
    const parts = normalized.split(" ");
    if (parts[1] === "run" && parts[2]) {
      return `${parts[0]} run ${parts[2]}`;
    }
    return parts.slice(0, 2).join(" ");
  }
  if (first === "cargo" || first === "git") {
    const parts = normalized.split(" ");
    return parts.slice(0, 2).join(" ");
  }
  return first;
}

function promptAttachmentKindForFile(
  file: File,
  allowedKinds: PromptAttachmentKind[]
): PromptAttachmentKind | null {
  if (allowedKinds.includes("image") && fileLooksImage(file)) {
    return "image";
  }
  if (allowedKinds.includes("text") && fileLooksText(file)) {
    return "text";
  }
  return null;
}

function fileLooksImage(file: File) {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name)
  );
}

function attachmentMimeForFile(file: File, kind: PromptAttachmentKind) {
  if (file.type) {
    return file.type;
  }
  if (kind === "image") {
    const ext = file.name.toLowerCase().split(".").pop();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "bmp") return "image/bmp";
    if (ext === "avif") return "image/avif";
    return "image/png";
  }
  return "text/plain";
}

function fileLooksText(file: File) {
  if (file.type.startsWith("text/")) {
    return true;
  }
  const mime = file.type.toLowerCase();
  if (
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/typescript",
      "application/x-sh",
      "application/x-yaml"
    ].includes(mime)
  ) {
    return true;
  }
  return /\.(txt|md|markdown|json|jsonl|csv|ts|tsx|js|jsx|py|rs|go|java|kt|swift|c|cpp|h|hpp|cs|html|css|scss|xml|ya?ml|toml|sql|sh|ps1|bat|log)$/i.test(
    file.name
  );
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取附件：${file.name}`));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.replace(/^data:[^;,]*/, `data:${mime}`));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取附件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
