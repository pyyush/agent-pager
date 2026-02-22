/** Cloudflare Worker environment bindings */
export interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  ENVIRONMENT: string;

  // Secrets (set via `wrangler secret put`)
  JWT_SECRET?: string;
  APPLE_APP_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TEAM_ID?: string;

  // Optional: comma-separated list of allowed CORS origins (e.g., "https://example.com")
  // If unset, no CORS headers are returned (safe default — iOS native app doesn't need CORS).
  ALLOWED_ORIGINS?: string;
}

/** Room creation request */
export interface CreateRoomRequest {
  /** Optional user ID (Phase 2 — omit for Phase 1) */
  userId?: string;
}

/** Room creation response */
export interface CreateRoomResponse {
  roomId: string;
  roomSecret: string;
}

/** Room status response */
export interface RoomStatusResponse {
  roomId: string;
  gatewayConnected: boolean;
  clientCount: number;
}

/** Device registration request (Phase 4) */
export interface RegisterDeviceRequest {
  apnsToken: string;
  deviceName?: string;
}

/** E2E encrypted message wrapper (Phase 3) */
export interface E2EMessage {
  e2e: true;
  nonce: string;
  ciphertext: string;
  /** Unencrypted routing hint for push (Phase 4) */
  hint?: {
    type: string;
    toolName?: string;
    risk?: string;
  };
}

/** Internal message between Durable Object and Worker */
export interface RoomMessage {
  /** Source: "gateway" or "client" */
  from: "gateway" | "client";
  /** Raw message data (opaque — relay does not parse) */
  data: string;
}
