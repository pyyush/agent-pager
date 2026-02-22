/**
 * Resource limits — prevents runaway memory/disk usage.
 * All values are conservative for a single-user, single-machine daemon.
 */

/** Max concurrent sessions (agents) */
export const MAX_SESSIONS = 20;

/** Max connected WebSocket clients */
export const MAX_CLIENTS = 5;

/** Max pending approvals per session */
export const MAX_PENDING_PER_SESSION = 100;

/** Max events stored in DB per session before pruning old entries */
export const MAX_DB_EVENTS_PER_SESSION = 50_000;

/** Max total DB size before warning (500MB) */
export const MAX_DB_SIZE_BYTES = 500 * 1024 * 1024;

/** Max hook payload size (1MB) */
export const MAX_HOOK_PAYLOAD_BYTES = 1024 * 1024;

/** Max WebSocket message size from clients (64KB) */
export const MAX_WS_MESSAGE_BYTES = 64 * 1024;

/** Max terminal output buffer per session (5MB) */
export const MAX_TERMINAL_BUFFER_BYTES = 5 * 1024 * 1024;
