import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generate a cryptographically secure auth token.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Uses Node's crypto.timingSafeEqual under the hood. When lengths differ,
 * performs a constant-time no-op comparison (bufA vs bufA) to avoid leaking
 * token length via timing side-channel, then returns false.
 */
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // constant-time no-op to prevent length leak
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
