#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const bridge = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const fake = fileURLToPath(import.meta.url);
const cwdA = process.cwd();
const cwdB = path.dirname(cwdA);
let tempDir;
let shutdownPidFile;

if (process.env.MUSE_BRIDGE_FAKE_MUSE === "1") {
  if (process.env.MUSE_BRIDGE_FAKE_MODE === "ignore-term") {
    writeFileSync(process.env.MUSE_BRIDGE_FAKE_PID_FILE, String(process.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        payload_type: "run.output.delta",
        payload: { text: "ok" },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        payload_type: "run.terminal.completed",
        payload: { terminal: "completed" },
      })}\n`,
    );
  }
} else {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "muse-acp-boundary-"));
  shutdownPidFile = path.join(tempDir, "ignored-term.pid");
  try {
    await runBoundaryChecks();
    await runShutdownCheck();
    console.log("Muse bridge boundary checks passed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function startBridge(extraEnv = {}) {
  const child = spawn(process.execPath, [bridge], {
    cwd: cwdA,
    env: {
      ...process.env,
      MUSE_ACP_BIN: fake,
      MUSE_ACP_PROVIDER: "echo",
      MUSE_BRIDGE_FAKE_MUSE: "1",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
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
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.id === id);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${method} response`));
        }, 10000);
        waiters.push({
          id,
          predicate: (message) => message.id === id,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
  };
}

async function runBoundaryChecks() {
  const bridgeProcess = startBridge();
  try {
    const initialized = await bridgeProcess.request(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    if (initialized.result?.agentCapabilities?.loadSession !== true) {
      throw new Error("bridge must advertise loadSession support");
    }

    const created = await bridgeProcess.request(2, "session/new", {
      cwd: cwdA,
      mcpServers: [],
    });
    const sessionId = created.result?.sessionId;
    if (!sessionId) throw new Error("session/new did not return a session id");

    for (const [id, method] of [
      [3, "session/resume"],
      [4, "session/load"],
    ]) {
      const response = await bridgeProcess.request(id, method, {
        sessionId,
        cwd: cwdB,
        mcpServers: [],
      });
      if (!response.error || !/refusing cwd/.test(response.error.message)) {
        throw new Error(`${method} must reject a cwd change`);
      }
    }

    const unknownPrompt = await bridgeProcess.request(5, "session/prompt", {
      sessionId: "unknown-session",
      prompt: [{ type: "text", text: "must not run" }],
    });
    if (
      !unknownPrompt.error ||
      !/Unknown ACP session/.test(unknownPrompt.error.message)
    ) {
      throw new Error("unknown session/prompt must fail closed");
    }

    const loadedId = "loaded-session";
    const loaded = await bridgeProcess.request(6, "session/load", {
      sessionId: loadedId,
      cwd: cwdA,
      mcpServers: [],
    });
    if (loaded.error) {
      throw new Error(`session/load failed: ${loaded.error.message}`);
    }
    const prompted = await bridgeProcess.request(7, "session/prompt", {
      sessionId: loadedId,
      prompt: [{ type: "text", text: "loaded session works" }],
    });
    if (prompted.result?.stopReason !== "end_turn") {
      throw new Error(
        `loaded session could not be prompted: ${JSON.stringify(prompted)}`,
      );
    }
  } finally {
    bridgeProcess.child.kill("SIGTERM");
    await onceClose(bridgeProcess.child);
  }
}

async function runShutdownCheck() {
  const bridgeProcess = startBridge({
    MUSE_BRIDGE_FAKE_MODE: "ignore-term",
    MUSE_BRIDGE_FAKE_PID_FILE: shutdownPidFile,
  });
  await bridgeProcess.request(1, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const created = await bridgeProcess.request(2, "session/new", {
    cwd: cwdA,
    mcpServers: [],
  });
  bridgeProcess.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "keep child alive" }],
      },
    })}\n`,
  );

  const deadline = Date.now() + 5000;
  while (!existsSync(shutdownPidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!existsSync(shutdownPidFile)) {
    throw new Error("fake Muse child did not start");
  }

  const pid = Number.parseInt(readFileSync(shutdownPidFile, "utf8"), 10);
  const startedAt = Date.now();
  bridgeProcess.child.kill("SIGTERM");
  const [code] = await onceClose(bridgeProcess.child);
  const elapsed = Date.now() - startedAt;
  if (code !== 143) throw new Error(`bridge exited with ${code}, expected 143`);
  if (elapsed < 1800) {
    throw new Error(`bridge exited before SIGKILL escalation (${elapsed}ms)`);
  }
  if (isAlive(pid)) {
    throw new Error("ignored-term Muse child survived bridge shutdown");
  }
}

function onceClose(child) {
  return new Promise((resolve) => child.once("close", (...args) => resolve(args)));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
