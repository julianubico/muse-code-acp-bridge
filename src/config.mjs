const DEFAULT_REASONING_EFFORT = "ultra";
const DEFAULT_MUSE_COMMAND = "muse";

export const PROTOCOL_VERSION = 1;
export const AGENT_NAME = "muse-acp-bridge";
export const AGENT_VERSION = "0.1.0";
export const MUSE_COMMAND = process.env.MUSE_ACP_BIN || DEFAULT_MUSE_COMMAND;

const parsedMaxQueuedPrompts = Number.parseInt(
  process.env.MUSE_ACP_MAX_QUEUED_PROMPTS || "32",
  10,
);
export const MAX_QUEUED_PROMPTS =
  Number.isFinite(parsedMaxQueuedPrompts) && parsedMaxQueuedPrompts >= 0
    ? parsedMaxQueuedPrompts
    : 32;

const parsedMaxConsecutiveToolFailures = Number.parseInt(
  process.env.MUSE_ACP_MAX_CONSECUTIVE_TOOL_FAILURES || "3",
  10,
);
export const MAX_CONSECUTIVE_TOOL_FAILURES =
  Number.isFinite(parsedMaxConsecutiveToolFailures) &&
  parsedMaxConsecutiveToolFailures >= 1
    ? parsedMaxConsecutiveToolFailures
    : 3;

export const VALID_SANDBOX_NETWORKS = new Set([
  "restricted",
  "proxy-only",
  "enabled",
]);
export const DEFAULT_SANDBOX_NETWORK = "proxy-only";
export const CHILD_TERM_GRACE_MS = 2000;
export const CHILD_KILL_WAIT_MS = 1000;

const TOOL_BOOLEAN_ARGUMENT_KEYS = new Set([
  "login",
  "tty",
  "allowNonZeroExit",
  "allow_non_zero_exit",
]);
const TOOL_INTEGER_ARGUMENT_KEYS = new Set([
  "yield_time_ms",
  "timeout_ms",
  "max_output_tokens",
  "yieldTimeMs",
  "timeoutMs",
  "maxOutputTokens",
]);

export function booleanEnv(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

export function normalizeToolArguments(value, key) {
  if (value === null || typeof value !== "object") {
    if (
      TOOL_BOOLEAN_ARGUMENT_KEYS.has(key) &&
      typeof value === "string" &&
      /^(true|false)$/i.test(value)
    ) {
      return value.toLowerCase() === "true";
    }
    if (
      TOOL_INTEGER_ARGUMENT_KEYS.has(key) &&
      typeof value === "string" &&
      /^(0|[1-9]\d*)$/.test(value)
    ) {
      const number = Number(value);
      if (Number.isSafeInteger(number)) {
        return number;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeToolArguments(item, key));
  }

  const normalized = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    normalized[childKey] = normalizeToolArguments(childValue, childKey);
  }
  return normalized;
}

export function museArgs(session, promptFile) {
  const args = [
    "exec",
    "--json",
    "--session-id",
    session.id,
    "--workspace",
    session.cwd,
    "--prompt-file",
    promptFile,
  ];
  const provider = (process.env.MUSE_ACP_PROVIDER || "meta").toLowerCase();

  if (process.env.MUSE_ACP_PROVIDER) {
    args.push("--provider", process.env.MUSE_ACP_PROVIDER);
  }

  if (process.env.MUSE_ACP_MODEL) {
    args.push("--model", process.env.MUSE_ACP_MODEL);
  }
  if (provider !== "echo") {
    args.push(
      "--reasoning-effort",
      process.env.MUSE_ACP_REASONING_EFFORT || DEFAULT_REASONING_EFFORT,
    );
  }
  const yolo = booleanEnv("MUSE_ACP_YOLO");
  const configuredSandboxNetwork = yolo
    ? undefined
    : process.env.MUSE_ACP_SANDBOX_NETWORK || DEFAULT_SANDBOX_NETWORK;
  if (configuredSandboxNetwork) {
    const sandboxNetwork = configuredSandboxNetwork.toLowerCase();
    if (!VALID_SANDBOX_NETWORKS.has(sandboxNetwork)) {
      throw new Error(
        "MUSE_ACP_SANDBOX_NETWORK must be restricted, proxy-only, or enabled",
      );
    }
    args.push("--sandbox-network", sandboxNetwork);
  }
  if (process.env.MUSE_ACP_MAX_MODEL_STEPS) {
    if (!/^[1-9]\d*$/.test(process.env.MUSE_ACP_MAX_MODEL_STEPS)) {
      throw new Error("MUSE_ACP_MAX_MODEL_STEPS must be a positive integer");
    }
    args.push("--max-model-steps", process.env.MUSE_ACP_MAX_MODEL_STEPS);
  }
  if (process.env.MUSE_ACP_MAX_TOOL_OUTPUT_BYTES) {
    if (!/^[1-9]\d*$/.test(process.env.MUSE_ACP_MAX_TOOL_OUTPUT_BYTES)) {
      throw new Error(
        "MUSE_ACP_MAX_TOOL_OUTPUT_BYTES must be a positive integer",
      );
    }
    args.push(
      "--max-tool-output-bytes",
      process.env.MUSE_ACP_MAX_TOOL_OUTPUT_BYTES,
    );
  }
  if (booleanEnv("MUSE_ACP_DISABLE_WEB_TOOLS")) {
    args.push("--disable-web-tools");
  }
  if (process.env.MUSE_ACP_APPROVAL_MODE) {
    args.push("--approval-mode", process.env.MUSE_ACP_APPROVAL_MODE);
  }
  const shellDisabled = booleanEnv("MUSE_ACP_DISABLE_SHELL");
  // Omission is the Muse 0.2.1 compatibility-safe default. An explicit
  // false value opts into the managed shell, whose headless argument
  // serialization is known to be unreliable in that release.
  const useLegacyShellTool =
    !shellDisabled &&
    (process.env.MUSE_ACP_ENABLE_SHELL_TOOL === undefined ||
      booleanEnv("MUSE_ACP_ENABLE_SHELL_TOOL"));
  if (useLegacyShellTool) {
    args.push("--enable-shell-tool");
  }
  if (yolo) {
    args.push("--yolo");
  } else {
    if (booleanEnv("MUSE_ACP_TRUST_WORKSPACE")) {
      args.push("--trust-workspace");
    }
    if (booleanEnv("MUSE_ACP_DISABLE_APPROVAL")) {
      args.push("--disable-approval");
    }
    if (booleanEnv("MUSE_ACP_DISABLE_SANDBOX")) {
      args.push("--disable-sandbox");
    }
    if (booleanEnv("MUSE_ACP_DISABLE_WRITE")) {
      args.push("--disable-write");
    }
    if (booleanEnv("MUSE_ACP_DISABLE_SHELL")) {
      args.push("--disable-shell");
    }
  }
  if (booleanEnv("MUSE_ACP_USER_INPUT_AUTO_RESOLVE")) {
    args.push("--user-input-auto-resolve");
  }

  return args;
}
