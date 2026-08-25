#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  DEFAULT_SANDBOX_NETWORK,
  MAX_CONSECUTIVE_TOOL_FAILURES,
  MAX_QUEUED_PROMPTS,
  museArgs,
  normalizeToolArguments,
} from "../src/config.mjs";
import {
  assertSupportedSessionParams,
  normalizeCwd,
  textFromPrompt,
} from "../src/content.mjs";
import {
  createEventProcessor,
  terminalResult,
  toolFailureKind,
  toolKind,
} from "../src/events.mjs";
import { cancelSession, childHasExited } from "../src/process.mjs";
import { createSessionManager } from "../src/session-manager.mjs";

const session = { id: "unit-session", cwd: "/tmp" };

assert.equal(normalizeToolArguments({ login: "false", timeout_ms: "12" }).login, false);
assert.equal(
  normalizeToolArguments({ login: "false", timeout_ms: "12" }).timeout_ms,
  12,
);
assert.equal(DEFAULT_SANDBOX_NETWORK, "proxy-only");
assert.ok(MAX_QUEUED_PROMPTS >= 0);
assert.ok(MAX_CONSECUTIVE_TOOL_FAILURES >= 1);

const savedEnv = {};
for (const name of [
  "MUSE_ACP_PROVIDER",
  "MUSE_ACP_MODEL",
  "MUSE_ACP_REASONING_EFFORT",
  "MUSE_ACP_SANDBOX_NETWORK",
  "MUSE_ACP_MAX_MODEL_STEPS",
  "MUSE_ACP_MAX_TOOL_OUTPUT_BYTES",
  "MUSE_ACP_APPROVAL_MODE",
  "MUSE_ACP_ENABLE_SHELL_TOOL",
  "MUSE_ACP_DISABLE_SHELL",
  "MUSE_ACP_DISABLE_WEB_TOOLS",
  "MUSE_ACP_YOLO",
  "MUSE_ACP_TRUST_WORKSPACE",
  "MUSE_ACP_DISABLE_APPROVAL",
  "MUSE_ACP_DISABLE_SANDBOX",
  "MUSE_ACP_DISABLE_WRITE",
  "MUSE_ACP_USER_INPUT_AUTO_RESOLVE",
]) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
const defaultArgs = museArgs(session, "/tmp/prompt.txt");
assert.deepEqual(
  defaultArgs.slice(-5),
  [
    "--reasoning-effort",
    "ultra",
    "--sandbox-network",
    "proxy-only",
    "--enable-shell-tool",
  ],
);
process.env.MUSE_ACP_PROVIDER = "echo";
process.env.MUSE_ACP_SANDBOX_NETWORK = "restricted";
process.env.MUSE_ACP_DISABLE_WEB_TOOLS = "1";
const configuredArgs = museArgs(session, "/tmp/prompt.txt");
assert.ok(configuredArgs.includes("--provider"));
assert.ok(configuredArgs.includes("restricted"));
assert.ok(configuredArgs.includes("--disable-web-tools"));
for (const [name, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

assert.equal(normalizeCwd("/tmp/../tmp"), "/tmp");
assert.throws(() => normalizeCwd("relative"), /absolute path/);
assert.equal(
  textFromPrompt([
    { type: "text", text: "hello" },
    { type: "resource_link", name: "notes" },
  ]),
  "hello\n\n[Referenced resource: notes]",
);
assert.throws(() => textFromPrompt([{ type: "image" }]), /does not support ACP image/);
assert.throws(
  () => assertSupportedSessionParams({ mcpServers: [{ name: "unsupported" }] }),
  /MCP server injection/,
);

assert.equal(toolKind("terminal.exec"), "execute");
assert.equal(
  toolFailureKind({ payload: { error: "expected a boolean for login" } }),
  "typed_arguments",
);
assert.deepEqual(
  terminalResult({ payload_type: "run.terminal.completed", payload: {} }),
  { stopReason: "end_turn" },
);

const updates = [];
const processor = createEventProcessor({
  notify: (method, params) => updates.push({ method, params }),
  terminateChild: async () => {},
  log: () => {},
  maxConsecutiveToolFailures: 3,
});
const eventSession = { id: "events", toolSequence: 0 };
const eventState = {
  child: {},
  messageId: "message",
  sawText: false,
  terminal: undefined,
  liveTools: new Map(),
  consecutiveToolFailures: 0,
  fatalTermination: null,
};
processor.processMuseRecord(
  eventSession,
  { payload_type: "run.output.delta", payload: { text: "hello" } },
  eventState,
);
processor.processMuseRecord(
  eventSession,
  {
    payload_type: "run.tool.started",
    payload: {
      tool_call: { id: "tool-1", name: "bash", login: "false", timeout_ms: "5" },
    },
  },
  eventState,
);
assert.equal(updates[0].params.update.content.text, "hello");
assert.equal(updates[1].params.update.rawInput.tool_call.login, false);
assert.equal(updates[1].params.update.rawInput.tool_call.timeout_ms, 5);

assert.equal(childHasExited({ exitCode: null, signalCode: null }), false);
assert.equal(childHasExited({ exitCode: 0, signalCode: null }), true);
const cancellable = {
  cancelled: false,
  pendingTasks: new Set([{ cancelled: false }]),
  child: null,
};
await cancelSession(cancellable);
assert.equal(cancellable.cancelled, true);
assert.equal([...cancellable.pendingTasks][0].cancelled, true);

let cancelCalls = 0;
const manager = createSessionManager({
  normalizeCwd,
  maxQueuedPrompts: 1,
  cancelSession: async (value) => {
    cancelCalls += 1;
    value.cancelled = true;
  },
  runPrompt: async () => ({ stopReason: "end_turn" }),
});
const managed = manager.sessionFor("managed", { cwd: "/tmp" });
assert.deepEqual(await manager.queuePrompt(managed, "prompt"), {
  stopReason: "end_turn",
});
assert.equal(manager.list()[0].sessionId, "managed");
await manager.closeSession("managed");
assert.equal(cancelCalls, 1);
assert.deepEqual(manager.list(), []);

console.log("extracted bridge modules passed unit checks");
