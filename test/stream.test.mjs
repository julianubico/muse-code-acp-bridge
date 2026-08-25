#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

if (process.env.MUSE_BRIDGE_FAKE_MUSE === "1") {
  if (process.env.MUSE_BRIDGE_ASSERT_ARGS === "1") {
    const args = process.argv.slice(2);
    const expectedReasoning =
      process.env.MUSE_BRIDGE_EXPECT_REASONING_EFFORT || "ultra";
    const requiredPairs = [
      ["--disable-approval"],
      ["--disable-web-tools"],
      ["--sandbox-network", "restricted"],
      ["--reasoning-effort", expectedReasoning],
      ["--enable-shell-tool"],
    ];
    for (const pair of requiredPairs) {
      const present =
        pair.length === 1
          ? args.includes(pair[0])
          : args.includes(pair[0]) && args[args.indexOf(pair[0]) + 1] === pair[1];
      if (!present) {
        console.error(`bridge did not forward Muse safety flag: ${pair.join(" ")}`);
        process.exit(1);
      }
    }
  }
  if (process.env.MUSE_BRIDGE_ASSERT_DEFAULTS === "1") {
    const args = process.argv.slice(2);
    const networkIndex = args.indexOf("--sandbox-network");
    if (
      networkIndex < 0 ||
      args[networkIndex + 1] !== "proxy-only" ||
      args.includes("--disable-web-tools") ||
      !args.includes("--enable-shell-tool")
    ) {
      console.error(
        "bridge defaults must use proxy-only networking with web tools enabled",
      );
      process.exit(1);
    }
  }

  const emit = (payloadType, payload) => {
    process.stdout.write(
      `${JSON.stringify({ payload_type: payloadType, payload })}\n`,
    );
  };

  emit("run.output.delta", { text: "first-" });
  emit("run.output.delta", { text: "second-" });
  emit("run.output.delta", { text: "third" });
  emit("run.terminal.completed", {
    terminal: "completed",
    reason: "normal completion",
  });
  process.exit(0);
}

const fakeMuse = process.argv[1];
const cwd = process.env.MUSE_ACP_SMOKE_CWD || process.cwd();
const parsedTimeoutMs = Number.parseInt(
  process.env.MUSE_ACP_TEST_TIMEOUT_MS || "30000",
  10,
);
const timeoutMs =
  Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? parsedTimeoutMs
    : 30000;
const child = spawn(process.execPath, [bridge], {
  cwd,
  env: {
    ...process.env,
    MUSE_ACP_BIN: fakeMuse,
    MUSE_BRIDGE_FAKE_MUSE: "1",
  },
  stdio: ["pipe", "pipe", "ignore"],
});

const chunks = [];
let buffer = "";
let finished = false;
let sessionId;

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
    if (message.id === 2) {
      sessionId = message.result?.sessionId;
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
          prompt: [{ type: "text", text: "stream test" }],
        },
      });
    }
    if (
      message.method === "session/update" &&
      message.params?.update?.sessionUpdate === "agent_message_chunk"
    ) {
      chunks.push(message.params.update.content?.text || "");
    }
    if (message.id === 3) {
      const output = chunks.join("");
      if (message.result?.stopReason !== "end_turn") {
        console.error("stream test did not finish the prompt");
        finish(1);
      } else if (output !== "first-second-third" || chunks.length !== 3) {
        console.error(`stream test lost output chunks: ${JSON.stringify(chunks)}`);
        finish(1);
      } else {
        console.log("Muse ACP bridge streamed all output chunks");
        finish(0);
      }
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
    console.error("stream test timed out");
    finish(1);
  }
}, timeoutMs).unref();
