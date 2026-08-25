import { randomUUID } from "node:crypto";

import { normalizeToolArguments } from "./config.mjs";

export function isObject(value) {
  return value !== null && typeof value === "object";
}

export function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function pickString(objects, keys) {
  for (const object of objects) {
    if (!isObject(object)) {
      continue;
    }
    for (const key of keys) {
      const value = stringValue(object[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

export function payloadParts(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  const event = isObject(payload.event) ? payload.event : {};
  return [event, payload, record];
}

export function toolKind(name) {
  const normalized = String(name || "").toLowerCase();
  if (/(read|cat|open|list|stat)/.test(normalized)) return "read";
  if (/(write|edit|patch|create|replace)/.test(normalized)) return "edit";
  if (/(delete|remove)/.test(normalized)) return "delete";
  if (/(move|rename)/.test(normalized)) return "move";
  if (/(search|grep|find|glob)/.test(normalized)) return "search";
  if (/(shell|exec|command|terminal|run)/.test(normalized)) return "execute";
  if (/(fetch|web|http|url)/.test(normalized)) return "fetch";
  if (/(think|reason)/.test(normalized)) return "think";
  return "other";
}

export function toolStatus(type) {
  if (/(failed|error|rejected)/.test(type)) return "failed";
  if (/(completed|complete|finished|succeeded|success)/.test(type)) {
    return "completed";
  }
  if (/(started|requested|pending|created)/.test(type)) return "pending";
  return "in_progress";
}

export function toolFailureKind(record) {
  const serialized = JSON.stringify(record).toLowerCase();
  if (
    /(invalid type|expected (a boolean|u64|usize)|tool (argument|schema)|schema validation|tool task rejected)/.test(
      serialized,
    )
  ) {
    return "typed_arguments";
  }
  if (
    /(unsandboxed execution requires human approval|approval prompts are disabled|unsandboxed operation)/.test(
      serialized,
    )
  ) {
    return "unsandboxed_approval";
  }
  return "tool_failure";
}

export function terminalResult(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  const event = isObject(payload.event) ? payload.event : {};
  const parts = payloadParts(record);
  const payloadType = String(record.payload_type || "").toLowerCase();
  const eventKind = String(event.kind || "").toLowerCase();
  const terminal = pickString(parts, ["terminal", "status", "state"]);
  const isTerminalRecord =
    payloadType.startsWith("run.terminal.") ||
    typeof payload.terminal === "string" ||
    eventKind === "terminal" ||
    eventKind.startsWith("terminal.");

  if (!isTerminalRecord) {
    return undefined;
  }

  const reason = pickString(parts, ["reason", "error", "message"]);
  const type = `${payloadType} ${eventKind} ${terminal || ""}`.toLowerCase();
  if (/(cancel|abort)/.test(type)) {
    return { stopReason: "cancelled" };
  }
  if (/(fail|error|reject)/.test(type)) {
    return {
      stopReason: "refusal",
      reason: reason || "Muse execution failed",
    };
  }
  return { stopReason: "end_turn" };
}

export function createEventProcessor({
  notify,
  terminateChild,
  log,
  maxConsecutiveToolFailures,
}) {
  function messageIdFor(session) {
    return `muse-message-${session.id}-${randomUUID()}`;
  }

  function emitText(session, text, messageId) {
    if (typeof text !== "string" || text.length === 0) {
      return false;
    }

    notify("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      },
    });
    return true;
  }

  function failFastToolState(state, reason) {
    if (state.terminal?.stopReason === "refusal") {
      return;
    }
    state.terminal = { stopReason: "refusal", reason };
    if (!state.fatalTermination) {
      state.fatalTermination = terminateChild(state.child).catch((error) => {
        log(`could not terminate Muse after a fatal tool failure: ${error.message}`);
      });
    }
  }

  function emitToolEvent(session, record, liveTools) {
    const payload = isObject(record.payload) ? record.payload : {};
    const event = isObject(payload.event) ? payload.event : {};
    const type = [
      stringValue(record.payload_type),
      stringValue(event.kind),
      stringValue(payload.kind),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!type.includes("tool")) {
      return;
    }

    const parts = payloadParts(record);
    const candidate =
      (isObject(payload.tool_call) && payload.tool_call) ||
      (isObject(payload.toolCall) && payload.toolCall) ||
      (isObject(event.tool_call) && event.tool_call) ||
      (isObject(event.toolCall) && event.toolCall) ||
      payload;
    const id =
      pickString([candidate, ...parts], [
        "tool_call_id",
        "toolCallId",
        "call_id",
        "callId",
      ]) || `muse-tool-${session.id}-${++session.toolSequence}`;
    const title =
      pickString([candidate, ...parts], [
        "title",
        "tool_name",
        "toolName",
        "name",
        "operation",
        "action",
      ]) || "Muse tool";
    const name = pickString([candidate, ...parts], ["tool_name", "toolName", "name"]);
    const explicitStatus = pickString(parts, ["status", "state", "outcome"]);
    const status = toolStatus(`${type} ${explicitStatus || ""}`);
    const kind = toolKind(name || title);
    const normalizedPayload = normalizeToolArguments(payload);

    if (status === "completed" || status === "failed") {
      if (liveTools.has(id)) {
        notify("session/update", {
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status,
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: JSON.stringify(normalizedPayload),
                },
              },
            ],
          },
        });
      } else {
        notify("session/update", {
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: id,
            title,
            name,
            kind,
            status,
            rawOutput: normalizedPayload,
          },
        });
      }
      liveTools.delete(id);
      return {
        status,
        failureKind: status === "failed" ? toolFailureKind(record) : undefined,
      };
    }

    liveTools.set(id, true);
    notify("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title,
        name,
        kind,
        status,
        rawInput: normalizedPayload,
      },
    });
    return {
      status,
      failureKind: status === "failed" ? toolFailureKind(record) : undefined,
    };
  }

  function processMuseRecord(session, record, state) {
    if (!isObject(record)) {
      return;
    }

    const payload = isObject(record.payload) ? record.payload : {};
    const event = isObject(payload.event) ? payload.event : {};
    const payloadType = String(record.payload_type || "").toLowerCase();

    if (payloadType === "run.output.delta" && typeof payload.text === "string") {
      if (emitText(session, payload.text, state.messageId)) {
        state.sawText = true;
      }
    }

    if (
      String(event.kind || "").toLowerCase() === "assistant_message_committed" &&
      !state.sawText &&
      typeof event.text === "string"
    ) {
      if (emitText(session, event.text, state.messageId)) {
        state.sawText = true;
      }
    }

    const toolEvent = emitToolEvent(session, record, state.liveTools);
    if (toolEvent?.status === "failed") {
      state.consecutiveToolFailures += 1;
      if (toolEvent.failureKind === "typed_arguments") {
        failFastToolState(
          state,
          "Muse emitted invalid typed tool arguments; refusing further retries. " +
            "The bridge expects boolean and integer tool fields to remain typed.",
        );
      } else if (toolEvent.failureKind === "unsandboxed_approval") {
        failFastToolState(
          state,
          "Muse requested an unsandboxed operation while provider approval was " +
            "disabled; refusing further retries. Keep the operation sandboxed " +
            "or explicitly opt into a disposable unsandboxed profile.",
        );
      } else if (state.consecutiveToolFailures >= maxConsecutiveToolFailures) {
        failFastToolState(
          state,
          `Muse produced ${state.consecutiveToolFailures} consecutive tool ` +
            "failures; refusing further retries.",
        );
      }
    } else if (toolEvent?.status === "completed") {
      state.consecutiveToolFailures = 0;
    }

    const terminal = terminalResult(record);
    if (terminal) {
      if (!state.sawText && typeof payload.text === "string") {
        if (emitText(session, payload.text, state.messageId)) {
          state.sawText = true;
        }
      }
      if (state.terminal?.stopReason !== "refusal") {
        state.terminal = terminal;
      }
    }
  }

  return { messageIdFor, processMuseRecord };
}
