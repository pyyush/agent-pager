/**
 * Simple in-memory rate limiter for Worker requests.
 *
 * Limits:
 * - WebSocket messages: 100/sec per room
 * - API requests: 10/sec per IP
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

// Clean up stale entries every 60 seconds
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

/**
 * Check if a request should be rate limited.
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();

  // Periodic cleanup
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    for (const [k, entry] of rateLimits) {
      if (now - entry.windowStart > windowMs * 2) {
        rateLimits.delete(k);
      }
    }
    lastCleanup = now;
  }

  const entry = rateLimits.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    rateLimits.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Rate limit middleware for API requests.
 * 10 requests per second per IP.
 */
export function checkApiRateLimit(request: Request): boolean {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return checkRateLimit(`api:${ip}`, 10, 1000);
}

/**
 * Rate limit for WebSocket messages per room.
 * 100 messages per second per room.
 */
export function checkRoomRateLimit(roomId: string): boolean {
  return checkRateLimit(`room:${roomId}`, 100, 1000);
}

/**
 * Rate limit for anonymous room creation.
 * 3 rooms per IP per hour — much tighter than the general API limit
 * because anonymous room creation is an abuse vector.
 */
export function checkAnonRoomCreationLimit(request: Request): boolean {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return checkRateLimit(`anon-room:${ip}`, 3, 3_600_000);
}
