import type { Env, E2EMessage } from "./types.js";
import { createAPNsClient, buildPermissionPushPayload } from "./apns.js";
import * as db from "./db.js";

/**
 * Durable Object: Room
 *
 * Each user's gateway gets a "room". The gateway connects outbound to the relay,
 * and iOS clients connect to the same room. Messages are forwarded opaquely —
 * the relay never parses message contents (they're E2E encrypted in Phase 3).
 *
 * When no clients are connected and a gateway sends a permission_request,
 * the room sends an APNs push notification to all registered devices.
 */
export class Room implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private gateways = new Set<WebSocket>();
  private clients = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore any hibernated WebSockets
    this.state.getWebSockets("gateway").forEach((ws) => this.gateways.add(ws));
    this.state.getWebSockets("client").forEach((ws) => this.clients.add(ws));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");

    if (role !== "gateway" && role !== "client") {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag the WebSocket so we can restore it after hibernation
    this.state.acceptWebSocket(server, [role]);

    if (role === "gateway") {
      this.gateways.add(server);
    } else {
      this.clients.add(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle incoming WebSocket messages — forward to the other side.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const data = typeof message === "string" ? message : new TextDecoder().decode(message);

    if (this.gateways.has(ws)) {
      // Gateway → all clients
      if (this.clients.size > 0) {
        for (const client of this.clients) {
          try {
            client.send(data);
          } catch {
            this.clients.delete(client);
          }
        }
      } else {
        // No clients connected — send APNs push if this is a permission request
        this.maybeSendPush(data);
      }
    } else if (this.clients.has(ws)) {
      // Client → gateway (first connected gateway)
      for (const gw of this.gateways) {
        try {
          gw.send(data);
        } catch {
          this.gateways.delete(gw);
        }
      }
    }
  }

  /**
   * Handle WebSocket close.
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    this.gateways.delete(ws);
    this.clients.delete(ws);
  }

  /**
   * Handle WebSocket error.
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    this.gateways.delete(ws);
    this.clients.delete(ws);
  }

  /**
   * Get room status.
   */
  getStatus(): { gatewayConnected: boolean; clientCount: number } {
    return {
      gatewayConnected: this.gateways.size > 0,
      clientCount: this.clients.size,
    };
  }

  /**
   * Check if a message is a permission request and send APNs push.
   * Works with both plaintext and E2E encrypted messages.
   */
  private maybeSendPush(data: string): void {
    try {
      const parsed = JSON.parse(data);

      let shouldPush = false;
      let hint: E2EMessage["hint"] | undefined;

      if (parsed.e2e === true) {
        // E2E message — check the unencrypted hint
        hint = parsed.hint;
        shouldPush = hint?.type === "permission_request";
      } else if (parsed.type === "permission_request") {
        // Plaintext message
        shouldPush = true;
        hint = {
          type: "permission_request",
          toolName: parsed.payload?.toolName,
          risk: parsed.payload?.riskLevel,
        };
      }

      if (!shouldPush) return;

      // Get room ID from Durable Object name
      const roomId = this.state.id.toString();

      // Send push asynchronously — don't block message forwarding
      this.sendPushToRoomDevices(roomId, hint).catch((err) => {
        console.error("APNs push failed:", err);
      });
    } catch {
      // Not JSON or parse error — skip push
    }
  }

  /**
   * Send APNs push to all devices associated with this room's user.
   */
  private async sendPushToRoomDevices(
    roomId: string,
    hint?: E2EMessage["hint"]
  ): Promise<void> {
    const apns = createAPNsClient(this.env);
    if (!apns) return; // APNs not configured

    // Look up room → user → devices
    const room = await db.getRoom(this.env.DB, roomId);
    if (!room) return;

    const userId = room.user_id as string;
    const devices = await db.getDevicesForUser(this.env.DB, userId);
    if (!devices.results || devices.results.length === 0) return;

    const payload = buildPermissionPushPayload(hint);

    // Send to all devices
    for (const device of devices.results) {
      const token = device.apns_token as string;
      if (!token) continue;

      const result = await apns.sendPush(token, payload, {
        collapseId: "permission-request",
      });

      if (!result.success) {
        console.warn(
          `APNs push failed for device ${(device.id as string).slice(0, 8)}: ${result.reason}`
        );
      }
    }
  }
}
