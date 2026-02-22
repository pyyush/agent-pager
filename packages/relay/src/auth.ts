import type { Env } from "./types.js";

/**
 * JWT claims for AgentPager tokens.
 */
export interface AgentPagerJWTClaims {
  sub: string; // user ID
  rooms: string[]; // allowed room IDs
  iss: string;
  iat: number;
  exp: number;
}

// ── Room secret auth (Phase 1) ──────────────────────────────────────

/**
 * Hash a room secret for storage in D1.
 */
export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a room secret against its hash.
 */
export async function verifySecret(
  secret: string,
  storedHash: string
): Promise<boolean> {
  const hash = await hashSecret(secret);
  // Constant-time comparison
  if (hash.length !== storedHash.length) return false;
  let result = 0;
  for (let i = 0; i < hash.length; i++) {
    result |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// ── Apple Sign In JWT validation (Phase 2) ───────────────────────────

/** Apple's JWKS endpoint */
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

/** Cached Apple public keys */
let appleKeysCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const APPLE_KEYS_TTL_MS = 3600_000; // 1 hour

async function getApplePublicKeys(): Promise<JsonWebKey[]> {
  if (
    appleKeysCache &&
    Date.now() - appleKeysCache.fetchedAt < APPLE_KEYS_TTL_MS
  ) {
    return appleKeysCache.keys;
  }

  const response = await fetch(APPLE_JWKS_URL);
  const { keys } = (await response.json()) as { keys: JsonWebKey[] };
  appleKeysCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/**
 * Validate an Apple Sign In identity token.
 * Returns the decoded payload if valid, null otherwise.
 */
export async function validateAppleIdentityToken(
  identityToken: string,
  appId: string
): Promise<{ sub: string; email?: string } | null> {
  try {
    const parts = identityToken.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(atob(parts[0]));
    const payload = JSON.parse(atob(parts[1]));

    // Verify issuer and audience
    if (payload.iss !== "https://appleid.apple.com") return null;
    if (payload.aud !== appId) return null;

    // Check expiry
    if (payload.exp * 1000 < Date.now()) return null;

    // Fetch Apple's public keys and find matching key
    const keys = await getApplePublicKeys();
    const matchingKey = keys.find(
      (k: any) => k.kid === header.kid && k.alg === header.alg
    );
    if (!matchingKey) return null;

    // Import key and verify signature
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      matchingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureBytes = base64UrlDecode(parts[2]);
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signatureBytes,
      dataBytes
    );

    if (!valid) return null;

    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

// ── AgentPager JWT (HS256) ─────────────────────────────────────────────

const JWT_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Generate a AgentPager JWT for authenticated users.
 */
export async function generateAgentPagerJWT(
  userId: string,
  rooms: string[],
  secret: string
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: AgentPagerJWTClaims = {
    sub: userId,
    rooms,
    iss: "agentpager-relay",
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const encodedSignature = base64UrlEncodeBuffer(signature);

  return `${data}.${encodedSignature}`;
}

/**
 * Validate a AgentPager JWT and return claims.
 */
export async function validateAgentPagerJWT(
  token: string,
  secret: string
): Promise<AgentPagerJWTClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const data = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(data)
    );

    if (!valid) return null;

    const payload = JSON.parse(atob(parts[1])) as AgentPagerJWTClaims;

    // Check expiry
    if (payload.exp * 1000 < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Base64url helpers ────────────────────────────────────────────────

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
