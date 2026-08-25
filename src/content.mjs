import path from "node:path";

function isObject(value) {
  return value !== null && typeof value === "object";
}

export function normalizeCwd(cwd) {
  if (cwd === undefined) {
    return process.cwd();
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("ACP session cwd must be an absolute path");
  }
  return path.normalize(cwd);
}

export function textFromPrompt(prompt) {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (!Array.isArray(prompt)) {
    throw new Error("ACP prompt must be an array of content blocks");
  }

  const chunks = [];
  for (const block of prompt) {
    if (!isObject(block)) {
      continue;
    }

    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          chunks.push(block.text);
        }
        break;
      case "resource_link":
        chunks.push(
          `[Referenced resource: ${block.name || block.uri || "unnamed resource"}]`,
        );
        break;
      case "resource":
        throw new Error(
          "Muse bridge does not support embedded ACP resources; use a resource_link",
        );
      case "image":
      case "audio":
        throw new Error(`Muse bridge does not support ACP ${block.type} prompt blocks`);
      default:
        chunks.push(`[Unsupported ACP content block: ${block.type || "unknown"}]`);
        break;
    }
  }

  const text = chunks.join("\n\n").trim();
  if (!text) {
    throw new Error("ACP prompt did not contain usable text");
  }
  return text;
}

export function assertSupportedSessionParams(params) {
  if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
    throw new Error(
      "Muse bridge does not support ACP MCP server injection; configure tools in Muse instead",
    );
  }
  if (
    Array.isArray(params.additionalDirectories) &&
    params.additionalDirectories.length > 0
  ) {
    throw new Error(
      "Muse bridge does not support ACP additionalDirectories; use the session cwd",
    );
  }
}
