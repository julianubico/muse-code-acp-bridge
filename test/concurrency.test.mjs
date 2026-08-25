#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const fakeMuse = fileURLToPath(new URL("./stream.test.mjs", import.meta.url));
const cwd = process.env.MUSE_ACP_SMOKE_CWD || process.cwd();
const parsedTimeoutMs = Number.parseInt(
  process.env.MUSE_ACP_TEST_TIMEOUT_MS || "120000",
  10,
);
const timeoutMs =
  Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? parsedTimeoutMs
    : 120000;
const child = spawn(process.execPath, [bridge], {
  cwd,
  env: {
    ...process.env,
    MUSE_ACP_BIN: fakeMuse,
    MUSE_ACP_PROVIDER: "echo",
    MUSE_BRIDGE_FAKE_MUSE: "1",
  },
  stdio: ["pipe", "pipe", "ignore"],
});

const expected = new Set([3, 4]);
const completed = new Set();
let buffer = "";
let finished = false;
let promptSent = false;

function finish(code) {
  if (finished) return;
  finished = true;
  child.kill("SIGTERM");
  process.exitCode = code;
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 2 && !promptSent) {
      promptSent = true;
      const sessionId = message.result?.sessionId;
      if (!sessionId) {
        console.error("session/new did not return a session id");
        finish(1);
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "queued one" }],
        },
      });
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "queued two" }],
        },
      });
    }
    if (expected.has(message.id) && message.result?.stopReason === "end_turn") {
      completed.add(message.id);
    }
    if (completed.size === expected.size) {
      console.log("concurrent ACP prompts serialized successfully");
      finish(0);
    }
  }
});

child.on("error", () => finish(1));
child.on("close", () => {
  if (!finished) finish(1);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
});
send({
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: { cwd, mcpServers: [] },
});

setTimeout(() => {
  if (!finished) {
    console.error("concurrent ACP prompt queue timed out");
    finish(1);
  }
}, timeoutMs).unref();
