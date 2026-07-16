import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkspaceRoot,
  canRestartAfterManualShutdown,
  shouldPublishWorkspace,
  shouldWakeODot
} from "./workspaceSync";

test("normalizes Windows roots and trailing separators", () => {
  assert.equal(normalizeWorkspaceRoot(" C:\\Work\\Demo\\\\ "), "c:/work/demo");
});

test("background windows never publish", () => {
  assert.equal(
    shouldPublishWorkspace({
      focused: false,
      force: true,
      workspaceRoot: "C:\\Work\\Demo",
      lastPublishedWorkspaceRoot: ""
    }),
    false
  );
});

test("force republishes after bridge restart", () => {
  assert.equal(
    shouldPublishWorkspace({
      focused: true,
      force: true,
      workspaceRoot: "C:\\Work\\Demo",
      lastPublishedWorkspaceRoot: "c:/work/demo"
    }),
    true
  );
});

test("unchanged roots are suppressed without force", () => {
  assert.equal(
    shouldPublishWorkspace({
      focused: true,
      force: false,
      workspaceRoot: "C:\\Work\\Demo",
      lastPublishedWorkspaceRoot: "c:/work/demo"
    }),
    false
  );
});

test("only missing discovery or refused connections trigger app wake", () => {
  assert.equal(shouldWakeODot({ code: "ENOENT" }), true);
  assert.equal(shouldWakeODot({ code: "ECONNREFUSED" }), true);
  assert.equal(shouldWakeODot(new Error("HTTP 400")), false);
  assert.equal(shouldWakeODot(new Error("protocol mismatch")), false);
  assert.equal(shouldWakeODot({ code: "ETIMEDOUT" }), false);
});

test("only explicit user actions can restart oDot", () => {
  assert.equal(canRestartAfterManualShutdown("heartbeat"), false);
  assert.equal(canRestartAfterManualShutdown("focus"), false);
  assert.equal(canRestartAfterManualShutdown("folder-change"), false);
  assert.equal(canRestartAfterManualShutdown("editor-change"), false);
  assert.equal(canRestartAfterManualShutdown("activation"), false);
  assert.equal(canRestartAfterManualShutdown("explicit"), true);
});
