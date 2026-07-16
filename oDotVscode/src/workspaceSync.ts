export function normalizeWorkspaceRoot(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function shouldPublishWorkspace(input: {
  focused: boolean;
  force: boolean;
  workspaceRoot: string;
  lastPublishedWorkspaceRoot: string;
}) {
  if (!input.focused || !input.workspaceRoot) {
    return false;
  }
  return (
    input.force ||
    normalizeWorkspaceRoot(input.workspaceRoot) !== input.lastPublishedWorkspaceRoot
  );
}

export function shouldWakeODot(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EHOSTUNREACH";
}

export function canRestartAfterManualShutdown(reason: string) {
  return reason === "explicit";
}
