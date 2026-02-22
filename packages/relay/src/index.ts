import type { Env, CreateRoomResponse, RoomStatusResponse } from "./types.js";
import {
  extractBearerToken,
  hashSecret,
  verifySecret,
  validateAppleIdentityToken,
  generateAgentPagerJWT,
  validateAgentPagerJWT,
} from "./auth.js";
import * as db from "./db.js";
import { checkApiRateLimit, checkAnonRoomCreationLimit } from "./middleware/rateLimit.js";

export { Room } from "./room.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS: only return headers when Origin matches an explicit allowlist.
    // iOS native app doesn't send Origin headers, so omitting CORS is safe for it.
    // Set ALLOWED_ORIGINS env var (comma-separated) to enable CORS for web clients.
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      if (!corsHeaders) {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Rate limit API requests
      if (url.pathname.startsWith("/api/") && !checkApiRateLimit(request)) {
        return withCors(
          Response.json({ error: "Rate limited" }, { status: 429 }),
          corsHeaders
        );
      }

      // ── WebSocket routes ───────────────────────────────────────────

      if (url.pathname === "/ws/gateway") {
        return handleGatewayWebSocket(request, env, url);
      }

      if (url.pathname === "/ws/client") {
        return handleClientWebSocket(request, env, url);
      }

      // ── REST API routes ────────────────────────────────────────────

      if (url.pathname === "/api/rooms" && request.method === "POST") {
        return withCors(await handleCreateRoom(request, env), corsHeaders);
      }

      if (url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/status")) {
        const roomId = url.pathname.split("/")[3];
        return withCors(await handleRoomStatus(roomId, env), corsHeaders);
      }

      if (url.pathname === "/api/auth/apple" && request.method === "POST") {
        return withCors(await handleAppleAuth(request, env), corsHeaders);
      }

      if (url.pathname === "/api/devices" && request.method === "POST") {
        return withCors(await handleRegisterDevice(request, env), corsHeaders);
      }

      if (url.pathname === "/api/health") {
        return withCors(Response.json({ status: "ok", timestamp: Date.now() }), corsHeaders);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Worker error:", err);
      return withCors(
        Response.json({ error: "Internal server error" }, { status: 500 }),
        corsHeaders
      );
    }
  },
};

// ── WebSocket handlers ───────────────────────────────────────────────

async function handleGatewayWebSocket(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const roomId = url.searchParams.get("room");
  if (!roomId) {
    return new Response("Missing room parameter", { status: 400 });
  }

  // Auth: verify room secret
  const token = extractBearerToken(request);
  if (!token) {
    return new Response("Missing authorization", { status: 401 });
  }

  const room = await db.getRoom(env.DB, roomId);
  if (!room) {
    return new Response("Room not found", { status: 404 });
  }

  const valid = await verifySecret(token, room.secret_hash as string);
  if (!valid) {
    return new Response("Invalid room secret", { status: 401 });
  }

  // Update last seen
  await db.updateRoomLastSeen(env.DB, roomId);

  // Forward to Durable Object
  const doId = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(doId);
  const doUrl = new URL(request.url);
  doUrl.searchParams.set("role", "gateway");
  return stub.fetch(new Request(doUrl.toString(), request));
}

async function handleClientWebSocket(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const roomId = url.searchParams.get("room");
  if (!roomId) {
    return new Response("Missing room parameter", { status: 400 });
  }

  // Auth: verify JWT or room secret
  const token = extractBearerToken(request);
  if (!token) {
    return new Response("Missing authorization", { status: 401 });
  }

  // Try JWT first (Phase 2), then fall back to room secret (Phase 1)
  let authorized = false;

  if (env.JWT_SECRET) {
    const claims = await validateAgentPagerJWT(token, env.JWT_SECRET);
    if (claims && claims.rooms.includes(roomId)) {
      authorized = true;
    }
  }

  if (!authorized) {
    // Phase 1 fallback: room secret
    const room = await db.getRoom(env.DB, roomId);
    if (room) {
      authorized = await verifySecret(token, room.secret_hash as string);
    }
  }

  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Forward to Durable Object
  const doId = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(doId);
  const doUrl = new URL(request.url);
  doUrl.searchParams.set("role", "client");
  return stub.fetch(new Request(doUrl.toString(), request));
}

// ── REST API handlers ────────────────────────────────────────────────

async function handleCreateRoom(
  request: Request,
  env: Env
): Promise<Response> {
  // NOTE: JWT_SECRET should be configured in production to require authenticated
  // room creation. Without it, rooms can be created anonymously (Phase 1 compat).
  const token = extractBearerToken(request);
  let userId: string;

  if (env.JWT_SECRET && token) {
    const claims = await validateAgentPagerJWT(token, env.JWT_SECRET);
    if (claims) {
      userId = claims.sub;
    } else {
      return Response.json({ error: "Invalid token" }, { status: 401 });
    }
  } else {
    // Anonymous room creation — apply tighter rate limit (3 per IP per hour)
    // to mitigate abuse when JWT_SECRET is not configured.
    if (!checkAnonRoomCreationLimit(request)) {
      return Response.json(
        { error: "Rate limited — too many anonymous rooms created" },
        { status: 429 }
      );
    }
    userId = crypto.randomUUID();
    await db.upsertUser(env.DB, userId, `anon-${userId}`, null, "");
  }

  const roomId = crypto.randomUUID();
  const roomSecret = generateRoomSecret();
  const secretHash = await hashSecret(roomSecret);

  await db.createRoom(env.DB, roomId, userId, secretHash);

  const response: CreateRoomResponse = { roomId, roomSecret };
  return Response.json(response, { status: 201 });
}

async function handleRoomStatus(
  roomId: string,
  env: Env
): Promise<Response> {
  const room = await db.getRoom(env.DB, roomId);
  if (!room) {
    return Response.json({ error: "Room not found" }, { status: 404 });
  }

  // Query the Durable Object for live status
  const doId = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(doId);

  try {
    const statusResponse = await stub.fetch(
      new Request(`https://internal/status?role=gateway`)
    );

    // If the DO returns 400 (no role match), that's fine — report as disconnected
    const response: RoomStatusResponse = {
      roomId,
      gatewayConnected: false,
      clientCount: 0,
    };
    return Response.json(response);
  } catch {
    return Response.json({
      roomId,
      gatewayConnected: false,
      clientCount: 0,
    } satisfies RoomStatusResponse);
  }
}

async function handleAppleAuth(
  request: Request,
  env: Env
): Promise<Response> {
  const appId = env.APPLE_APP_ID;
  const jwtSecret = env.JWT_SECRET;

  if (!appId || !jwtSecret) {
    return Response.json(
      { error: "Apple auth not configured" },
      { status: 501 }
    );
  }

  const body = (await request.json()) as {
    identityToken: string;
    displayName?: string;
  };

  if (!body.identityToken) {
    return Response.json(
      { error: "Missing identityToken" },
      { status: 400 }
    );
  }

  const applePayload = await validateAppleIdentityToken(
    body.identityToken,
    appId
  );
  if (!applePayload) {
    return Response.json(
      { error: "Invalid Apple identity token" },
      { status: 401 }
    );
  }

  // Upsert user
  const existing = await db.getUserByAppleId(env.DB, applePayload.sub);
  const userId = (existing?.id as string) || crypto.randomUUID();
  const isNewUser = !existing;

  await db.upsertUser(
    env.DB,
    userId,
    applePayload.sub,
    applePayload.email || null,
    body.displayName || ""
  );

  // Get user's rooms for JWT
  const rooms = await db.getRoomsForUser(env.DB, userId);
  const roomIds = (rooms.results || []).map((r: any) => r.id as string);

  // Generate JWT
  const token = await generateAgentPagerJWT(userId, roomIds, jwtSecret);

  return Response.json({ token, userId, isNewUser });
}

async function handleRegisterDevice(
  request: Request,
  env: Env
): Promise<Response> {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    return Response.json(
      { error: "Auth not configured" },
      { status: 501 }
    );
  }

  const token = extractBearerToken(request);
  if (!token) {
    return Response.json({ error: "Missing authorization" }, { status: 401 });
  }

  const claims = await validateAgentPagerJWT(token, jwtSecret);
  if (!claims) {
    return Response.json({ error: "Invalid token" }, { status: 401 });
  }

  const body = (await request.json()) as {
    apnsToken: string;
    deviceName?: string;
  };

  if (!body.apnsToken) {
    return Response.json({ error: "Missing apnsToken" }, { status: 400 });
  }

  const deviceId = crypto.randomUUID();
  await db.registerDevice(
    env.DB,
    deviceId,
    claims.sub,
    body.apnsToken,
    body.deviceName || ""
  );

  return Response.json({ deviceId });
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateRoomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function withCors(response: Response, corsHeaders: Record<string, string> | null): Response {
  if (!corsHeaders) return response;
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Build CORS headers only if the request Origin is in the ALLOWED_ORIGINS allowlist.
 * Returns null if no CORS headers should be sent (origin missing or not allowed).
 */
function getCorsHeaders(request: Request, env: Env): Record<string, string> | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  const allowedRaw = env.ALLOWED_ORIGINS;
  if (!allowedRaw) return null;

  const allowed = allowedRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin",
  };
}
