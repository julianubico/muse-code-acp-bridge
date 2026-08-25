#!/usr/bin/env node

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const fakeMuse = fileURLToPath(new URL("./stream.test.mjs", import.meta.url));
process.env.MUSE_ACP_BIN = fakeMuse;
process.env.MUSE_ACP_PROVIDER = "echo";
process.env.MUSE_BRIDGE_FAKE_MUSE = "1";

const { runMusePrompt } = await import("../src/muse-runner.mjs");

const updates = [];
const session = {
  id: "runner-session",
  cwd: process.cwd(),
  child: null,
  cancelled: false,
  toolSequence: 0,
};
const result = await runMusePrompt(session, "runner prompt", {
  isShuttingDown: () => false,
  log: () => {},
  notify: (method, params) => updates.push({ method, params }),
});

assert.deepEqual(result, { stopReason: "end_turn" });
assert.deepEqual(
  updates.map(({ params }) => params.update.content.text),
  ["first-", "second-", "third"],
);
assert.equal(session.child, null);
console.log("Muse runner passed unit checks");
