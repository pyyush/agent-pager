import type { RiskLevel } from "./events.js";
import { READ_ONLY_TOOLS } from "./constants.js";

/** Patterns for destructive bash commands */
const DESTRUCTIVE_PATTERNS =
  /\b(rm\s+-[^\s]*r|rm\s+-[^\s]*f|rmdir|dd\s+|mkfs|format\s+|git\s+push\s+--force|git\s+push\s+-f|git\s+reset\s+--hard|git\s+clean\s+-[^\s]*f|drop\s+table|drop\s+database|truncate\s+table|>\s*\/dev\/|shutdown|reboot|kill\s+-9|pkill\s+-9|chmod\s+777|chown\s+root)\b/i;

/** Patterns for package/dependency installation */
const INSTALL_PATTERNS =
  /\b(npm\s+install|npm\s+i\s|pnpm\s+(add|install)|yarn\s+add|pip\s+install|pip3\s+install|brew\s+install|apt\s+install|apt-get\s+install|cargo\s+install|go\s+install)\b/i;

/** Patterns for network access */
const NETWORK_PATTERNS =
  /\b(curl|wget|fetch|nc\s|ncat|ssh\s|scp\s|rsync\s|docker\s+pull|docker\s+push)\b/i;

/** System paths that shouldn't be written to */
const SYSTEM_PATH_PATTERN = /^\/(etc|usr|var|boot|sys|proc)\//;

/** Credential/secret file extensions */
const CREDENTIAL_FILE_PATTERN = /\.(env|pem|key|crt|p12|pfx|jks|keystore)$/i;

/**
 * Classify the risk level of an agent tool invocation.
 *
 * Runs on the gateway before sending permission requests to clients.
 * Deterministic, pure function — no IO.
 */
export function classifyRisk(
  toolName: string,
  toolInput: Record<string, unknown>
): RiskLevel {
  // Read-only tools are always safe
  if ((READ_ONLY_TOOLS as readonly string[]).includes(toolName)) {
    return "safe";
  }

  // Bash: content analysis
  if (toolName === "Bash") {
    const cmd = (toolInput.command as string) || "";
    if (DESTRUCTIVE_PATTERNS.test(cmd)) return "dangerous";
    // Plain rm (no -rf flags) is still a delete — moderate
    if (/\brm\s/.test(cmd)) return "moderate";
    if (INSTALL_PATTERNS.test(cmd)) return "moderate";
    if (NETWORK_PATTERNS.test(cmd)) return "moderate";
    return "safe";
  }

  // Write/Edit: path analysis
  if (toolName === "Write" || toolName === "Edit") {
    const path = (toolInput.file_path as string) || "";
    if (SYSTEM_PATH_PATTERN.test(path)) return "dangerous";
    if (CREDENTIAL_FILE_PATTERN.test(path)) return "moderate";
    return "safe";
  }

  // NotebookEdit: same as Write
  if (toolName === "NotebookEdit") {
    const path = (toolInput.notebook_path as string) || "";
    if (SYSTEM_PATH_PATTERN.test(path)) return "dangerous";
    if (CREDENTIAL_FILE_PATTERN.test(path)) return "moderate";
    return "safe";
  }

  // MCP tools, subagents, unknown tools: moderate by default
  return "moderate";
}

/**
 * Generate a human-readable summary of a tool invocation.
 */
export function summarizeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash": {
      const cmd = (toolInput.command as string) || "";
      // Truncate long commands
      return cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
    }
    case "Write":
      return `Write to ${toolInput.file_path || "unknown file"}`;
    case "Edit":
      return `Edit ${toolInput.file_path || "unknown file"}`;
    case "Read":
      return `Read ${toolInput.file_path || "unknown file"}`;
    case "Glob":
      return `Search for files: ${toolInput.pattern || ""}`;
    case "Grep":
      return `Search content: ${toolInput.pattern || ""}`;
    case "NotebookEdit":
      return `Edit notebook ${toolInput.notebook_path || "unknown"}`;
    default:
      return `${toolName}`;
  }
}

/**
 * Extract the target path/resource from a tool invocation.
 */
export function extractTarget(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash":
      return (toolInput.command as string) || "";
    case "Write":
    case "Edit":
    case "Read":
      return (toolInput.file_path as string) || "";
    case "NotebookEdit":
      return (toolInput.notebook_path as string) || "";
    case "Glob":
      return (toolInput.pattern as string) || "";
    case "Grep":
      return (toolInput.pattern as string) || "";
    default:
      return JSON.stringify(toolInput).slice(0, 200);
  }
}

/**
 * Categorize a tool by its general function.
 */
export function categorrizeTool(toolName: string): string {
  if ((READ_ONLY_TOOLS as readonly string[]).includes(toolName)) return "read";
  if (["Write", "Edit", "NotebookEdit"].includes(toolName)) return "write";
  if (toolName === "Bash") return "execute";
  if (toolName === "Task") return "subagent";
  return "other";
}
