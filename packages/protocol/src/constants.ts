/** Protocol version — major bump = breaking change */
export const PROTOCOL_VERSION = "1.0.0";

/** Default ports */
export const DEFAULT_HOOK_HTTP_PORT = 7890;
export const DEFAULT_WS_PORT = 7891;

/** Unix socket paths (relative to ~/.agentpager/) */
export const GATEWAY_SOCK = "gateway.sock";
export const HOOK_SOCK = "hook.sock";

/** Session status values */
export const SESSION_STATUSES = [
  "created",
  "running",
  "waiting",
  "error",
  "stopped",
  "done",
] as const;

/** Risk levels (ordered from safest to most dangerous) */
export const RISK_LEVELS = ["safe", "moderate", "dangerous"] as const;

/** Approval scopes */
export const APPROVAL_SCOPES = ["once", "session", "tool"] as const;

/** Supported agents */
export const AGENT_NAMES = ["claude", "codex", "gemini"] as const;

/** tmux session prefixes per agent */
export const TMUX_PREFIXES: Record<string, string> = {
  claude: "ap-cc",
  codex: "ap-cx",
  gemini: "ap-gm",
};

/** Heartbeat interval in ms */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Heartbeat timeout (missed acks) */
export const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Max missed heartbeats before disconnect */
export const MAX_MISSED_HEARTBEATS = 3;

/** Reconnect backoff */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Event ring buffer size per session */
export const EVENT_BUFFER_SIZE = 10_000;

/** Max diff size before fallback to terminal view */
export const MAX_DIFF_BYTES = 256 * 1024; // 256KB

/** Terminal frame coalescing interval */
export const FRAME_INTERVAL_MS = 16; // ~60fps

/** Backpressure watermarks */
export const HIGH_WATERMARK = 1024 * 1024; // 1MB
export const LOW_WATERMARK = 256 * 1024; // 256KB

/** Terminal scrollback lines */
export const SCROLLBACK_LINES = 10_000;

/** Approval timeout */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Dangerous action delay (undo window) */
export const DANGEROUS_DELAY_MS = 2_000;

/** TOTP pairing rate limit */
export const TOTP_MAX_ATTEMPTS = 3;
export const TOTP_WINDOW_MS = 60_000;
export const TOTP_CODE_EXPIRY_S = 30;

/** Default relay URL */
export const DEFAULT_RELAY_URL = "wss://relay.agentpager.dev";

/** Relay reconnect interval */
export const RELAY_RECONNECT_BASE_MS = 2_000;
export const RELAY_RECONNECT_MAX_MS = 60_000;

/** Read-only tools (always safe) */
export const READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
] as const;
