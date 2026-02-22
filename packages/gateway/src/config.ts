import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_HOOK_HTTP_PORT,
  DEFAULT_WS_PORT,
  APPROVAL_TIMEOUT_MS,
  DANGEROUS_DELAY_MS,
  EVENT_BUFFER_SIZE,
  SCROLLBACK_LINES,
  MAX_DIFF_BYTES,
  DEFAULT_RELAY_URL,
} from "@agentpager/protocol";

export interface GatewayConfig {
  /** Base directory for all AgentPager state (~/.agentpager) */
  dataDir: string;

  /** HTTP port for hook ingestion (backward compat with Agent Pager) */
  hookHttpPort: number;

  /** WebSocket port for client connections (LAN/remote) */
  wsPort: number;

  /** Auth token for hook HTTP endpoint */
  hookToken: string;

  /** Approval timeout in ms (auto-deny after this) */
  approvalTimeoutMs: number;

  /** Delay before relaying dangerous approvals (undo window) */
  dangerousDelayMs: number;

  /** Max events kept in ring buffer per session */
  eventBufferSize: number;

  /** Terminal scrollback lines */
  scrollbackLines: number;

  /** Max diff size in bytes before fallback */
  maxDiffBytes: number;

  /** Auto-approve safe tool invocations */
  autoApproveSafe: boolean;

  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";

  /**
   * Bind address for the WebSocket/HTTP LAN server.
   * Default: "127.0.0.1" (localhost only — safe).
   * Set to "0.0.0.0" to listen on all interfaces (LAN access for iOS app).
   * Override via AGENTPAGER_BIND_HOST env var or bind_host in config.toml.
   */
  bindHost: string;

  // ── Relay (cloud connectivity) ──────────────────────────────────

  /** Enable cloud relay transport */
  relayEnabled: boolean;

  /** Relay WebSocket URL */
  relayUrl: string;

  /** Room ID on the relay */
  relayRoomId: string;

  /** Room secret for relay authentication */
  relayRoomSecret: string;
}

const DEFAULT_CONFIG: GatewayConfig = {
  dataDir: join(homedir(), ".agentpager"),
  hookHttpPort: DEFAULT_HOOK_HTTP_PORT,
  wsPort: DEFAULT_WS_PORT,
  hookToken: "",
  approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  dangerousDelayMs: DANGEROUS_DELAY_MS,
  eventBufferSize: EVENT_BUFFER_SIZE,
  scrollbackLines: SCROLLBACK_LINES,
  maxDiffBytes: MAX_DIFF_BYTES,
  autoApproveSafe: false,
  logLevel: "info",
  bindHost: "127.0.0.1",
  relayEnabled: false,
  relayUrl: DEFAULT_RELAY_URL,
  relayRoomId: "",
  relayRoomSecret: "",
};

/**
 * Load config from TOML file, falling back to env vars and defaults.
 * Config file: ~/.agentpager/config.toml
 * Env fallback: reads .env in cwd (Bun handles this natively)
 */
export async function loadConfig(
  overrides?: Partial<GatewayConfig>
): Promise<GatewayConfig> {
  const config = { ...DEFAULT_CONFIG, ...overrides };

  // Ensure data directory exists
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  }

  // Try loading TOML config
  const configPath = join(config.dataDir, "config.toml");
  if (existsSync(configPath)) {
    try {
      const toml = await import("toml");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = toml.parse(raw);

      if (parsed.hook_http_port) config.hookHttpPort = parsed.hook_http_port;
      if (parsed.ws_port) config.wsPort = parsed.ws_port;
      if (parsed.hook_token) config.hookToken = parsed.hook_token;
      if (parsed.approval_timeout_ms)
        config.approvalTimeoutMs = parsed.approval_timeout_ms;
      if (parsed.dangerous_delay_ms)
        config.dangerousDelayMs = parsed.dangerous_delay_ms;
      if (parsed.event_buffer_size)
        config.eventBufferSize = parsed.event_buffer_size;
      if (parsed.scrollback_lines)
        config.scrollbackLines = parsed.scrollback_lines;
      if (parsed.max_diff_bytes) config.maxDiffBytes = parsed.max_diff_bytes;
      if (parsed.auto_approve_safe !== undefined)
        config.autoApproveSafe = parsed.auto_approve_safe;
      if (parsed.log_level) config.logLevel = parsed.log_level;
      if (parsed.bind_host) config.bindHost = parsed.bind_host;

      // Relay config
      if (parsed.relay_enabled !== undefined)
        config.relayEnabled = parsed.relay_enabled;
      if (parsed.relay_url) config.relayUrl = parsed.relay_url;
      if (parsed.relay_room_id) config.relayRoomId = parsed.relay_room_id;
      if (parsed.relay_room_secret)
        config.relayRoomSecret = parsed.relay_room_secret;
    } catch (err) {
      console.warn(`[config] Failed to parse ${configPath}:`, err);
    }
  }

  // Env var overrides (backward compat with Agent Pager's .env)
  if (process.env.BRIDGE_PORT)
    config.hookHttpPort = parseInt(process.env.BRIDGE_PORT, 10);
  if (process.env.BRIDGE_SECRET) config.hookToken = process.env.BRIDGE_SECRET;
  if (process.env.AGENTPAGER_LOG_LEVEL)
    config.logLevel = process.env.AGENTPAGER_LOG_LEVEL as GatewayConfig["logLevel"];
  if (process.env.AGENTPAGER_BIND_HOST)
    config.bindHost = process.env.AGENTPAGER_BIND_HOST;

  // Generate token if missing (mandatory — unlike Agent Pager)
  if (!config.hookToken) {
    config.hookToken = randomBytes(32).toString("base64url");
    await writeTokenToConfig(config.dataDir, config.hookToken);
  }

  return config;
}

async function writeTokenToConfig(
  dataDir: string,
  token: string
): Promise<void> {
  const configPath = join(dataDir, "config.toml");
  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  // Append or replace hook_token
  if (content.includes("hook_token")) {
    const updated = content.replace(/hook_token\s*=\s*"[^"]*"/, `hook_token = "${token}"`);
    await Bun.write(configPath, updated);
  } else {
    const line = `\nhook_token = "${token}"\n`;
    await Bun.write(configPath, content + line);
  }

  console.log(`[config] Generated hook token → ${configPath}`);
}

/** Get the path to the SQLite database */
export function dbPath(config: GatewayConfig): string {
  return join(config.dataDir, "agentpager.db");
}

/** Get the path to the gateway Unix socket */
export function gatewaySocketPath(config: GatewayConfig): string {
  return join(config.dataDir, "gateway.sock");
}

/** Get the path to the hook Unix socket */
export function hookSocketPath(config: GatewayConfig): string {
  return join(config.dataDir, "hook.sock");
}
