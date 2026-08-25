#!/usr/bin/env node

/**
 * ACP compatibility bridge for Muse Code.
 *
 * Muse Code exposes a JSONL headless command (`muse exec --json`) rather than
 * an ACP server. This process adapts ACP's stdio JSON-RPC lifecycle to one Muse
 * session per ACP session.
 *
 * The implementation is intentionally split into small ESM modules:
 * configuration and Muse argument mapping, ACP content validation, event
 * translation, child-process lifecycle, and session queue management.
 */

import { randomUUID } from "node:crypto";
import readline from "node:readline";

import {
  AGENT_NAME,
  AGENT_VERSION,
  MAX_QUEUED_PROMPTS,
  PROTOCOL_VERSION,
} from "./config.mjs";
import {
  assertSupportedSessionParams,
  normalizeCwd,
  textFromPrompt,
} from "./content.mjs";
import { cancelSession } from "./process.mjs";
import { runMusePrompt } from "./muse-runner.mjs";
import { createSessionManager } from "./session-manager.mjs";

let shuttingDown = false;
let shutdownPromise;

function log(message) {
  process.stderr.write(`[${AGENT_NAME}] ${message}\n`);
}

function send(message) {
  if (!process.stdout.writableEnded) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  send({ jsonrpc: "2.0", id, error });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

const sessions = createSessionManager({
  normalizeCwd,
  cancelSession,
  maxQueuedPrompts: MAX_QUEUED_PROMPTS,
  runPrompt: (session, prompt) =>
    runMusePrompt(session, prompt, {
      isShuttingDown: () => shuttingDown,
      log,
      notify,
    }),
});

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (typeof method !== "string") {
    if (id !== undefined) {
      respondError(id, -32600, "Invalid ACP request");
    }
    return;
  }
  if (shuttingDown) {
    if (id !== undefined) {
      respondError(id, -32000, "Muse ACP bridge is shutting down");
    }
    return;
  }

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
          sessionCapabilities: {
            resume: {},
            close: {},
          },
        },
        agentInfo: {
          name: AGENT_NAME,
          version: AGENT_VERSION,
        },
      });
      return;

    case "authenticate":
      respond(id, {});
      return;

    case "session/new": {
      assertSupportedSessionParams(params);
      const sessionId = randomUUID();
      sessions.sessionFor(sessionId, params);
      respond(id, { sessionId });
      return;
    }

    case "session/resume":
      assertSupportedSessionParams(params);
      sessions.sessionFor(params.sessionId, params);
      respond(id, {});
      return;

    case "session/load":
      assertSupportedSessionParams(params);
      sessions.sessionFor(params.sessionId, params);
      respond(id, {});
      return;

    case "session/set_mode":
      throw new Error("Muse bridge does not expose ACP session modes");

    case "session/set_config_option":
      throw new Error(
        "Muse bridge does not expose ACP session config options; use MUSE_ACP_* environment variables",
      );

    case "session/close":
      await sessions.closeSession(params.sessionId);
      respond(id, {});
      return;

    case "session/delete":
      await sessions.deleteSession(params.sessionId);
      respond(id, {});
      return;

    case "session/prompt": {
      const session = sessions.requireSession(params.sessionId);
      const prompt = textFromPrompt(params.prompt);
      respond(id, await sessions.queuePrompt(session, prompt));
      return;
    }

    case "session/cancel":
      await sessions.cancel(params.sessionId);
      return;

    case "session/list":
      respond(id, { sessions: sessions.list() });
      return;

    default:
      throw new Error(`Unsupported ACP method: ${method}`);
  }
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log(`invalid JSON from ACP client: ${error.message}`);
    return;
  }

  void handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      respondError(message.id, -32000, error.message);
    } else {
      log(error.message);
    }
  });
});

async function shutdown(exitCode) {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shuttingDown = true;
  input.close();
  shutdownPromise = (async () => {
    const activeSessions = sessions.all();
    await Promise.all(activeSessions.map((session) => cancelSession(session)));
    await Promise.all(
      activeSessions.map((session) => session.promptTail.catch(() => {})),
    );
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.on("SIGTERM", () => {
  void shutdown(143);
});

process.on("SIGINT", () => {
  void shutdown(130);
});
