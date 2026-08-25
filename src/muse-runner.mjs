import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_CONSECUTIVE_TOOL_FAILURES,
  MUSE_COMMAND,
  museArgs,
} from "./config.mjs";
import { createEventProcessor } from "./events.mjs";
import { terminateChild } from "./process.mjs";

export async function runMusePrompt(
  session,
  prompt,
  { isShuttingDown, notify, log },
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "muse-acp-"));
  const promptFile = path.join(tempDir, "prompt.txt");
  let child;
  try {
    await writeFile(promptFile, prompt, "utf8");
    if (session.cancelled || isShuttingDown()) {
      return { stopReason: "cancelled" };
    }

    const args = museArgs(session, promptFile);
    child = spawn(MUSE_COMMAND, args, {
      cwd: session.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    session.child = child;
    session.cancelled = false;

    const { messageIdFor, processMuseRecord } = createEventProcessor({
      notify,
      terminateChild,
      log,
      maxConsecutiveToolFailures: MAX_CONSECUTIVE_TOOL_FAILURES,
    });
    const state = {
      child,
      messageId: messageIdFor(session),
      sawText: false,
      terminal: undefined,
      liveTools: new Map(),
      consecutiveToolFailures: 0,
      fatalTermination: null,
    };
    let stdoutBuffer = "";

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            processMuseRecord(session, JSON.parse(line), state);
          } catch (error) {
            log(`could not parse Muse event: ${error.message}`);
          }
        }
      });

      child.stdout.on("end", () => {
        if (stdoutBuffer.trim()) {
          try {
            processMuseRecord(session, JSON.parse(stdoutBuffer), state);
          } catch (error) {
            log(`could not parse final Muse event: ${error.message}`);
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        process.stderr.write(`[muse] ${chunk.toString()}`);
      });

      child.on("error", (error) => finish(reject, error));
      child.on("close", (code, signal) => {
        if (session.cancelled) {
          finish(resolve, { stopReason: "cancelled" });
          return;
        }
        if (state.terminal?.stopReason === "refusal") {
          finish(
            reject,
            new Error(state.terminal.reason || "Muse execution failed"),
          );
          return;
        }
        if (state.terminal?.stopReason === "cancelled") {
          finish(resolve, state.terminal);
          return;
        }
        if (code === 0 && state.terminal?.stopReason === "end_turn") {
          finish(resolve, { stopReason: "end_turn" });
          return;
        }
        if (code === 0 && !state.terminal) {
          finish(reject, new Error("Muse exited without a terminal event"));
          return;
        }
        finish(
          reject,
          new Error(
            `Muse exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
      });
    });
    return result;
  } finally {
    if (session.child === child) {
      session.child = null;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
