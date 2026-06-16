const CONTEXT_LINES = 3;

export function createUnifiedDiffPreview(
  filePath: string,
  oldContent: string,
  newContent: string
): string {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - 1 - suffixLength] ===
      newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const oldChangeEnd = oldLines.length - suffixLength;
  const newChangeEnd = newLines.length - suffixLength;
  const oldStart = Math.max(0, prefixLength - CONTEXT_LINES);
  const newStart = Math.max(0, prefixLength - CONTEXT_LINES);
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + CONTEXT_LINES);
  const newEnd = Math.min(newLines.length, newChangeEnd + CONTEXT_LINES);
  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`
  ];

  for (let index = oldStart; index < prefixLength; index += 1) {
    lines.push(` ${oldLines[index]}`);
  }

  for (let index = prefixLength; index < oldChangeEnd; index += 1) {
    lines.push(`-${oldLines[index]}`);
  }

  for (let index = prefixLength; index < newChangeEnd; index += 1) {
    lines.push(`+${newLines[index]}`);
  }

  const sharedSuffixStart = oldLines.length - suffixLength;
  for (let index = sharedSuffixStart; index < oldEnd; index += 1) {
    lines.push(` ${oldLines[index]}`);
  }

  return `${lines.join("\n")}\n`;
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [""];
  }

  return content.replace(/\r\n/g, "\n").split("\n");
}

