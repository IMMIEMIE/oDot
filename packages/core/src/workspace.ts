import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type {
  ApplyResult,
  FileContent,
  ProjectFile,
  ProposedFileChange
} from "./types";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".odot",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "out",
  ".turbo",
  ".cache"
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript React"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript React"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".json", "JSON"],
  [".css", "CSS"],
  [".scss", "SCSS"],
  [".html", "HTML"],
  [".md", "Markdown"],
  [".rs", "Rust"],
  [".go", "Go"],
  [".py", "Python"],
  [".java", "Java"],
  [".kt", "Kotlin"],
  [".swift", "Swift"],
  [".cs", "C#"],
  [".cpp", "C++"],
  [".c", "C"],
  [".h", "C/C++ Header"],
  [".yaml", "YAML"],
  [".yml", "YAML"],
  [".toml", "TOML"],
  [".xml", "XML"],
  [".sql", "SQL"],
  [".sh", "Shell"],
  [".ps1", "PowerShell"]
]);

type ListOptions = {
  maxFiles?: number;
  maxFileSizeBytes?: number;
};

export async function ensureDirectory(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`${resolved} is not a directory.`);
  }
  return resolved;
}

export function resolveInsideProject(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relation = path.relative(resolvedRoot, target);

  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }

  return target;
}

export async function listProjectFiles(
  root: string,
  options: ListOptions = {}
): Promise<ProjectFile[]> {
  const resolvedRoot = await ensureDirectory(root);
  const maxFiles = options.maxFiles ?? 1000;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 250_000;
  const files: ProjectFile[] = [];
  const stack = [resolvedRoot];

  while (stack.length > 0 && files.length < maxFiles) {
    const currentDirectory = stack.pop();
    if (!currentDirectory) {
      continue;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const info = await stat(fullPath);
      if (info.size > maxFileSizeBytes) {
        continue;
      }

      if (!(await isLikelyTextFile(fullPath))) {
        continue;
      }

      files.push({
        path: toProjectPath(path.relative(resolvedRoot, fullPath)),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        language: detectLanguage(fullPath)
      });

      if (files.length >= maxFiles) {
        break;
      }
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readProjectFiles(
  root: string,
  relativePaths: string[]
): Promise<FileContent[]> {
  const resolvedRoot = await ensureDirectory(root);

  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const target = resolveInsideProject(resolvedRoot, relativePath);
      const content = await readFile(target, "utf8");
      return {
        path: toProjectPath(relativePath),
        content
      };
    })
  );
}

export async function applyFileChanges(
  root: string,
  changes: ProposedFileChange[]
): Promise<ApplyResult> {
  if (changes.length === 0) {
    throw new Error("No changes to apply.");
  }

  const resolvedRoot = await ensureDirectory(root);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(resolvedRoot, ".odot", "backups", timestamp);
  const pendingWrites: Array<{
    relativePath: string;
    target: string;
    currentContent: string;
    updatedContent: string;
  }> = [];

  for (const change of changes) {
    const target = resolveInsideProject(resolvedRoot, change.path);
    await access(target, constants.R_OK | constants.W_OK);
    const currentContent = await readFile(target, "utf8");

    if (currentContent !== change.originalContent) {
      throw new Error(
        `File changed after proposal was generated. Refresh and try again: ${change.path}`
      );
    }

    pendingWrites.push({
      relativePath: toProjectPath(change.path),
      target,
      currentContent,
      updatedContent: change.updatedContent
    });
  }

  for (const pending of pendingWrites) {
    const backupPath = path.join(backupDir, pending.relativePath);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, pending.currentContent, "utf8");
  }

  for (const pending of pendingWrites) {
    await writeFile(pending.target, pending.updatedContent, "utf8");
  }

  return {
    applied: pendingWrites.map((write) => write.relativePath),
    backupDir
  };
}

async function isLikelyTextFile(fullPath: string): Promise<boolean> {
  const buffer = await readFile(fullPath);
  const sample = buffer.subarray(0, 512);
  return !sample.includes(0);
}

function detectLanguage(fullPath: string): string {
  return LANGUAGE_BY_EXTENSION.get(path.extname(fullPath).toLowerCase()) ?? "Text";
}

function toProjectPath(value: string): string {
  return value.split(path.sep).join("/");
}

