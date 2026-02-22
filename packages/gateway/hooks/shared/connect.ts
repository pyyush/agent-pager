/**
 * Shared utility for AgentPager hook scripts.
 *
 * Posts JSON to the gateway's hook ingestion server.
 * Prefers the Unix socket (~/.agentpager/hook.sock) for speed (~2ms),
 * falls back to HTTP (127.0.0.1:7890) if the socket doesn't exist.
 *
 * Auth token is read from ~/.agentpager/config.toml via regex (no toml dep).
 *
 * Exit codes:
 *   0 = approved / success
 *   2 = blocked / denied
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".agentpager");

/**
 * Get the current tmux session name (if running inside tmux).
 */
async function getTmuxSessionName(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(
      ["tmux", "display-message", "-p", "#{session_name}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const name = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return proc.exitCode === 0 && name ? name : undefined;
  } catch {
    return undefined;
  }
}
const SOCKET_PATH = join(DATA_DIR, "hook.sock");
const HTTP_FALLBACK = "http://127.0.0.1:7890";

/**
 * Read hook_token from ~/.agentpager/config.toml using a simple regex.
 * Returns empty string if the file doesn't exist or the key isn't found.
 */
function readToken(): string {
  // Env var overrides take priority (backward compat with Agent Pager)
  if (process.env.AGENTPAGER_TOKEN) return process.env.AGENTPAGER_TOKEN;
  if (process.env.BRIDGE_SECRET) return process.env.BRIDGE_SECRET;

  const configPath = join(DATA_DIR, "config.toml");
  try {
    const content = readFileSync(configPath, "utf-8");
    const match = content.match(/hook_token\s*=\s*"([^"]*)"/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export interface ConnectResult {
  blocked: boolean;
  reason?: string;
  [key: string]: unknown;
}

/**
 * POST JSON to the gateway hook endpoint.
 *
 * @param path   - URL path, e.g. "/hook/claude/PreToolUse"
 * @param payload - JSON-serializable body
 * @returns Parsed JSON response from the gateway
 */
export async function postToGateway(
  path: string,
  payload: unknown
): Promise<ConnectResult> {
  const token = readToken();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Only attach auth header for HTTP transport (Unix socket is OS-enforced)
  const useSocket = existsSync(SOCKET_PATH);

  if (!useSocket && token) {
    headers["X-AgentPager-Token"] = token;
  }

  const url = useSocket
    ? `http://localhost${path}` // hostname is ignored for unix sockets
    : `${HTTP_FALLBACK}${path}`;

  const fetchOptions: RequestInit & { unix?: string } = {
    method: "POST",
    headers,
    body,
  };

  if (useSocket) {
    fetchOptions.unix = SOCKET_PATH;
  }

  const response = await fetch(url, fetchOptions);
  const json = (await response.json()) as ConnectResult;
  return json;
}

/**
 * Read all of stdin as a string. Used by hook scripts to consume the
 * JSON event that the agent CLI pipes in.
 */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Convenience: read stdin JSON, post to gateway, exit with the right code.
 *
 * For blocking hooks (PreToolUse, BeforeTool): exits 0 if approved, 2 if blocked.
 * For fire-and-forget hooks (Notification, Stop): always exits 0.
 *
 * @param path     - Gateway endpoint path
 * @param blocking - Whether this hook blocks on approval (default: false)
 */
export async function runHook(
  path: string,
  blocking: boolean = false
): Promise<never> {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};

    // Pass terminal context so gateway can send keys back to this session
    if (process.env.TMUX) {
      payload._tmuxSession = await getTmuxSessionName();
    }

    // Pass the agent's working directory so the session shows the project name
    payload._cwd = process.cwd();
    const result = await postToGateway(path, payload);

    if (blocking && result.blocked) {
      // Print the denial reason to stderr so the agent can display it
      if (result.reason) {
        process.stderr.write(`[agentpager] Blocked: ${result.reason}\n`);
      }
      process.exit(2);
    }

    process.exit(0);
  } catch (err) {
    // Hook failures should not block the agent — fail open
    process.stderr.write(
      `[agentpager] Hook error (failing open): ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
