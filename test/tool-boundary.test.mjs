#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const bridge = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const fake = fileURLToPath(import.meta.url);
const cwd = process.cwd();

if (process.env.MUSE_BRIDGE_FAKE_MUSE === "1") {
  const args = process.argv.slice(2);
  const expectedLegacyShell =
    process.env.MUSE_BRIDGE_EXPECT_LEGACY_SHELL ??
    process.env.MUSE_BRIDGE_ASSERT_LEGACY_SHELL;
  if (expectedLegacyShell !== undefined) {
    const actualLegacyShell = args.includes("--enable-shell-tool");
    const shouldUseLegacyShell = expectedLegacyShell === "1";
    if (actualLegacyShell !== shouldUseLegacyShell) {
      console.error(
        `unexpected Muse shell path: expected legacy=${shouldUseLegacyShell}, ` +
          `argv=${JSON.stringify(args)}`,
      );
      process.exit(1);
    }
  }

  const emit = (payloadType, payload) => {
    process.stdout.write(
      `${JSON.stringify({ payload_type: payloadType, payload })}\n`,
    );
  };

  if (process.env.MUSE_BRIDGE_FAKE_MODE === "typed") {
    const toolCall = {
      id: "typed-tool-call",
      name: "bash",
      command: "ls -la",
      login: "false",
      tty: "false",
      yield_time_ms: "10000",
      timeout_ms: "15000",
      max_output_tokens: "8000",
      sandbox_permissions: "use_default",
      nullable: null,
    };
    emit("run.tool.started", { tool_call: toolCall });
    emit("run.output.delta", { text: "typed-tool-ok" });
    emit("run.tool.completed", {
      tool_call: toolCall,
      status: "completed",
      output: { exit_code: "0" },
    });
    emit("run.terminal.completed", {
      terminal: "completed",
      reason: "normal completion",
    });
    process.exit(0);
  }

  if (process.env.MUSE_BRIDGE_FAKE_MODE === "schema-failure") {
    emit("run.tool.rejected", {
      tool_call: { id: "bad-tool-call", name: "bash" },
      status: "rejected",
      error: 'invalid type: string "false", expected a boolean',
    });
    setInterval(() => {}, 1000);
  } else if (process.env.MUSE_BRIDGE_FAKE_MODE === "approval-failure") {
    emit("run.tool.rejected", {
      tool_call: { id: "unsandboxed-tool-call", name: "bash" },
      status: "rejected",
      error:
        "tool denied: unsandboxed execution requires human approval, but approval prompts are disabled",
    });
    setInterval(() => {}, 1000);
  } else if (process.env.MUSE_BRIDGE_FAKE_MODE === "generic-failure") {
    for (let index = 0; index < 3; index += 1) {
      emit("run.tool.rejected", {
        tool_call: { id: `generic-tool-call-${index}`, name: "bash" },
        status: "rejected",
        error: "transient tool failure",
      });
    }
    setInterval(() => {}, 1000);
  }
} else {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "muse-acp-tool-boundary-"));
  try {
    await runShellSwitchCheck();
    await runTypedArgumentCheck();
    await runFailFastCheck(
      "schema-failure",
      /invalid typed tool arguments/i,
    );
    await runFailFastCheck(
      "approval-failure",
      /unsandboxed operation while provider approval was disabled/i,
    );
    await runFailFastCheck(
      "generic-failure",
      /3 consecutive tool failures/i,
    );
    console.log("Muse bridge tool boundary checks passed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function startBridge(extraEnv = {}, unsetEnv = []) {
  const env = {
    ...process.env,
    MUSE_ACP_BIN: fake,
    MUSE_ACP_PROVIDER: "echo",
    MUSE_BRIDGE_FAKE_MUSE: "1",
    MUSE_BRIDGE_ASSERT_LEGACY_SHELL: "1",
    MUSE_ACP_MAX_CONSECUTIVE_TOOL_FAILURES: "3",
    ...extraEnv,
  };
  for (const name of unsetEnv) {
    delete env[name];
  }

  const child = spawn(process.execPath, [bridge], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });

  let buffer = "";
  const messages = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.predicate(message)) {
          waiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
    }
  });

  return {
    child,
    request(id, method, params = {}) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return waitFor((message) => message.id === id, 10000);
    },
    notification(predicate) {
      return waitFor(predicate, 10000);
    },
  };

  function waitFor(predicate, timeoutMs) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.predicate === predicate);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for bridge message"));
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
}

async function initializeSession(bridgeProcess) {
  await bridgeProcess.request(1, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const created = await bridgeProcess.request(2, "session/new", {
    cwd,
    mcpServers: [],
  });
  const sessionId = created.result?.sessionId;
  if (!sessionId) throw new Error("session/new did not return a session id");
  return sessionId;
}

async function runShellSwitchCheck() {
  await runShellPathCheck(
    "omitted",
    { MUSE_BRIDGE_EXPECT_LEGACY_SHELL: "1" },
    ["MUSE_ACP_ENABLE_SHELL_TOOL"],
  );
  await runShellPathCheck("one", {
    MUSE_ACP_ENABLE_SHELL_TOOL: "1",
    MUSE_BRIDGE_EXPECT_LEGACY_SHELL: "1",
  });
  await runShellPathCheck(
    "zero",
    {
      MUSE_ACP_ENABLE_SHELL_TOOL: "0",
      MUSE_BRIDGE_EXPECT_LEGACY_SHELL: "0",
    },
  );
}

async function runShellPathCheck(label, extraEnv, unsetEnv = []) {
  const bridgeProcess = startBridge(
    { MUSE_BRIDGE_FAKE_MODE: "typed", ...extraEnv },
    unsetEnv,
  );
  try {
    const sessionId = await initializeSession(bridgeProcess);
    const response = await bridgeProcess.request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `${label} shell switch test` }],
    });
    if (response.result?.stopReason !== "end_turn") {
      throw new Error(`${label} shell switch test did not complete`);
    }
  } finally {
    bridgeProcess.child.kill("SIGTERM");
    await onceClose(bridgeProcess.child);
  }
}

async function runTypedArgumentCheck() {
  const bridgeProcess = startBridge({ MUSE_BRIDGE_FAKE_MODE: "typed" });
  try {
    const sessionId = await initializeSession(bridgeProcess);
    const responsePromise = bridgeProcess.request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "typed tool test" }],
    });
    const toolUpdate = await bridgeProcess.notification(
      (message) =>
        message.method === "session/update" &&
        message.params?.update?.sessionUpdate === "tool_call" &&
        message.params?.update?.status === "pending",
    );
    const input = toolUpdate.params.update.rawInput.tool_call;
    if (typeof input.login !== "boolean" || input.login !== false) {
      throw new Error("login was not normalized to boolean false");
    }
    if (typeof input.tty !== "boolean" || input.tty !== false) {
      throw new Error("tty was not normalized to boolean false");
    }
    for (const [key, expected] of [
      ["yield_time_ms", 10000],
      ["timeout_ms", 15000],
      ["max_output_tokens", 8000],
    ]) {
      if (typeof input[key] !== "number" || input[key] !== expected) {
        throw new Error(`${key} was not normalized to integer ${expected}`);
      }
    }
    if (input.sandbox_permissions !== "use_default") {
      throw new Error("sandbox_permissions was not preserved as a string");
    }
    if (input.nullable !== null) {
      throw new Error("null tool arguments must remain null");
    }
    if ("omitted" in input) {
      throw new Error("omitted tool arguments must remain omitted");
    }

    const response = await responsePromise;
    if (response.result?.stopReason !== "end_turn") {
      throw new Error("typed tool test did not complete");
    }
  } finally {
    bridgeProcess.child.kill("SIGTERM");
    await onceClose(bridgeProcess.child);
  }
}

async function runFailFastCheck(mode, expectedMessage) {
  const bridgeProcess = startBridge({ MUSE_BRIDGE_FAKE_MODE: mode });
  try {
    const sessionId = await initializeSession(bridgeProcess);
    const startedAt = Date.now();
    const response = await bridgeProcess.request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `${mode} test` }],
    });
    const elapsed = Date.now() - startedAt;
    if (!response.error || !expectedMessage.test(response.error.message)) {
      throw new Error(
        `${mode} did not return the expected bounded failure: ${JSON.stringify(
          response,
        )}`,
      );
    }
    if (elapsed > 5000) {
      throw new Error(`${mode} failure was not bounded (${elapsed}ms)`);
    }
  } finally {
    bridgeProcess.child.kill("SIGTERM");
    await onceClose(bridgeProcess.child);
  }
}

function onceClose(child) {
  return new Promise((resolve) => child.once("close", resolve));
}
