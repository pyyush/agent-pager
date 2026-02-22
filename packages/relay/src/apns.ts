import type { Env } from "./types.js";

/**
 * APNs HTTP/2 client for sending push notifications.
 *
 * Uses ES256 JWT auth with the Apple .p8 key stored as a Worker secret.
 * Auto-refreshes the JWT every 50 minutes (Apple requires < 60 min).
 */
export class APNsClient {
  private cachedJWT: { token: string; expiresAt: number } | null = null;

  constructor(
    private teamId: string,
    private keyId: string,
    private privateKeyPem: string,
    private production = true
  ) {}

  private get baseUrl(): string {
    return this.production
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  }

  /**
   * Send a push notification to a device.
   */
  async sendPush(
    deviceToken: string,
    payload: APNsPayload,
    options: APNsPushOptions = {}
  ): Promise<APNsResult> {
    const jwt = await this.getJWT();

    const body = JSON.stringify({
      aps: {
        alert: payload.alert,
        sound: payload.sound ?? "default",
        badge: payload.badge,
        category: payload.category,
        "thread-id": payload.threadId,
        "interruption-level": payload.interruptionLevel ?? "time-sensitive",
        "mutable-content": payload.mutableContent ? 1 : undefined,
      },
      ...payload.customData,
    });

    const response = await fetch(
      `${this.baseUrl}/3/device/${deviceToken}`,
      {
        method: "POST",
        headers: {
          Authorization: `bearer ${jwt}`,
          "apns-topic": options.topic ?? "com.agentpager.ios",
          "apns-push-type": options.pushType ?? "alert",
          "apns-priority": String(options.priority ?? 10),
          "apns-expiration": String(options.expiration ?? 0),
          ...(options.collapseId
            ? { "apns-collapse-id": options.collapseId }
            : {}),
        },
        body,
      }
    );

    if (response.ok) {
      return { success: true };
    }

    const errorBody = await response.text();
    return {
      success: false,
      statusCode: response.status,
      reason: errorBody,
    };
  }

  /**
   * Get or refresh the APNs JWT.
   */
  private async getJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    if (this.cachedJWT && now < this.cachedJWT.expiresAt) {
      return this.cachedJWT.token;
    }

    const header = { alg: "ES256", kid: this.keyId };
    const claims = { iss: this.teamId, iat: now };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedClaims = base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${encodedHeader}.${encodedClaims}`;

    // Import the P8 private key
    const key = await this.importPrivateKey();

    // Sign with ES256
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput)
    );

    // Convert DER signature to raw r||s format for JWT
    const rawSignature = derToRaw(new Uint8Array(signature));
    const encodedSignature = base64UrlEncodeBuffer(rawSignature);

    const token = `${signingInput}.${encodedSignature}`;

    // Cache for 50 minutes (Apple allows up to 60)
    this.cachedJWT = { token, expiresAt: now + 3000 };

    return token;
  }

  private async importPrivateKey(): Promise<CryptoKey> {
    // Parse the P8 PEM key
    const pemContent = this.privateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s/g, "");

    const binaryKey = Uint8Array.from(atob(pemContent), (c) =>
      c.charCodeAt(0)
    );

    return crypto.subtle.importKey(
      "pkcs8",
      binaryKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  }
}

/**
 * Create an APNs client from Worker environment secrets.
 * Returns null if required secrets are not configured.
 */
export function createAPNsClient(env: Env): APNsClient | null {
  if (!env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY || !env.APNS_TEAM_ID) {
    return null;
  }

  const isProduction = env.ENVIRONMENT === "production";
  return new APNsClient(
    env.APNS_TEAM_ID,
    env.APNS_KEY_ID,
    env.APNS_PRIVATE_KEY,
    isProduction
  );
}

/**
 * Build a push payload for a permission request.
 */
export function buildPermissionPushPayload(hint?: {
  type: string;
  toolName?: string;
  risk?: string;
}): APNsPayload {
  const toolName = hint?.toolName ?? "Tool";
  const risk = hint?.risk ?? "moderate";

  return {
    alert: {
      title: `${toolName} needs approval`,
      body: `Risk: ${risk}`,
    },
    sound: "default",
    category: "PERMISSION_REQUEST",
    interruptionLevel: risk === "dangerous" ? "critical" : "time-sensitive",
    customData: {
      type: "permission_request",
      toolName,
      risk,
    },
  };
}

// ── Types ────────────────────────────────────────────────────────────

export interface APNsPayload {
  alert: { title: string; body: string } | string;
  sound?: string;
  badge?: number;
  category?: string;
  threadId?: string;
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
  mutableContent?: boolean;
  customData?: Record<string, unknown>;
}

export interface APNsPushOptions {
  topic?: string;
  pushType?: "alert" | "background" | "voip";
  priority?: 5 | 10;
  expiration?: number;
  collapseId?: string;
}

export interface APNsResult {
  success: boolean;
  statusCode?: number;
  reason?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeBuffer(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format.
 * DER: 0x30 [len] 0x02 [r-len] [r] 0x02 [s-len] [s]
 * Raw: [r (32 bytes)] [s (32 bytes)]
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // Simple DER parser for ECDSA signatures
  let offset = 2; // Skip 0x30 and total length

  // Read r
  offset++; // Skip 0x02
  const rLen = der[offset++];
  let r = der.slice(offset, offset + rLen);
  offset += rLen;

  // Read s
  offset++; // Skip 0x02
  const sLen = der[offset++];
  let s = der.slice(offset, offset + sLen);

  // Normalize to 32 bytes each (remove leading zeros, pad if needed)
  const rNorm = normalizeScalar(r, 32);
  const sNorm = normalizeScalar(s, 32);

  const raw = new Uint8Array(64);
  raw.set(rNorm, 0);
  raw.set(sNorm, 32);
  return raw;
}

function normalizeScalar(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length === length) return bytes;
  if (bytes.length > length) {
    // Remove leading zeros
    return bytes.slice(bytes.length - length);
  }
  // Pad with leading zeros
  const padded = new Uint8Array(length);
  padded.set(bytes, length - bytes.length);
  return padded;
}
