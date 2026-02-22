import type { Env } from "./types.js";

// ── User queries ─────────────────────────────────────────────────────

export async function getUser(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
}

export async function getUserByAppleId(db: D1Database, appleUserId: string) {
  return db
    .prepare("SELECT * FROM users WHERE apple_user_id = ?")
    .bind(appleUserId)
    .first();
}

export async function upsertUser(
  db: D1Database,
  userId: string,
  appleUserId: string,
  email: string | null,
  displayName: string
) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO users (id, apple_user_id, email, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(apple_user_id) DO UPDATE SET
         email = COALESCE(excluded.email, users.email),
         display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE users.display_name END`
    )
    .bind(userId, appleUserId, email, displayName, now)
    .run();
}

// ── Room queries ─────────────────────────────────────────────────────

export async function createRoom(
  db: D1Database,
  roomId: string,
  userId: string,
  secretHash: string
) {
  const now = Date.now();
  return db
    .prepare(
      "INSERT INTO rooms (id, user_id, secret_hash, last_seen, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(roomId, userId, secretHash, now, now)
    .run();
}

export async function getRoom(db: D1Database, roomId: string) {
  return db
    .prepare("SELECT * FROM rooms WHERE id = ?")
    .bind(roomId)
    .first();
}

export async function getRoomsForUser(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM rooms WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all();
}

export async function updateRoomLastSeen(db: D1Database, roomId: string) {
  return db
    .prepare("UPDATE rooms SET last_seen = ? WHERE id = ?")
    .bind(Date.now(), roomId)
    .run();
}

// ── Device queries (Phase 4) ─────────────────────────────────────────

export async function registerDevice(
  db: D1Database,
  deviceId: string,
  userId: string,
  apnsToken: string,
  deviceName: string
) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO devices (id, user_id, apns_token, device_name, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         apns_token = excluded.apns_token,
         device_name = CASE WHEN excluded.device_name != '' THEN excluded.device_name ELSE devices.device_name END,
         last_seen = excluded.last_seen`
    )
    .bind(deviceId, userId, apnsToken, deviceName, now, now)
    .run();
}

export async function getDevicesForUser(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen DESC")
    .bind(userId)
    .all();
}
