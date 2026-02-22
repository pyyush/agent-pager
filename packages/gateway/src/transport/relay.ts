import type { MessageEnvelope, ActionType } from "@agentpager/protocol";
import {
  createEnvelope,
  ACTION_PAYLOAD_SCHEMAS,
  RELAY_RECONNECT_BASE_MS,
  RELAY_RECONNECT_MAX_MS,
} from "@agentpager/protocol";
import type { ActionHandler, ConnectHandler, WSClient } from "./websocket.js";
import { E2EEncryption, isE2EMessage, type E2EWireMessage } from "../security/encryption.js";

export interface RelayConfig {
  relayUrl: string;
  roomId: string;
  roomSecret: string;
  /** Ed25519 private key for E2E encryption (optional — Phase 3) */
  gatewayPrivateKey?: Uint8Array;
  /** Peer's Ed25519 public key for E2E encryption (optional — Phase 3) */
  peerPublicKey?: Uint8Array;
}

/**
 * RelayTransport — connects outbound to the cloud relay.
 *
 * The gateway opens a WebSocket to the relay as a "gateway" role.
 * Messages from iOS clients arrive through the relay and are dispatched
 * to the same action handlers as the LAN WebSocket transport.
 *
 * Runs alongside the LAN transport — both active simultaneously.
 */
export class RelayTransport {
  private ws: WebSocket | null = null;
  private actionHandler: ActionHandler | null = null;
  private connectHandler: ConnectHandler | null = null;
  private seqCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private e2e: E2EEncryption | null = null;

  /** Synthetic client ID for relay-connected clients */
  private readonly relayClientId = "relay-gateway";

  constructor(private config: RelayConfig) {
    // Initialize E2E encryption if keys are provided
    if (config.gatewayPrivateKey && config.peerPublicKey) {
      this.e2e = new E2EEncryption();
    }
  }

  onAction(handler: ActionHandler): void {
    this.actionHandler = handler;
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandler = handler;
  }

  async start(): Promise<void> {
    this.closed = false;

    // Derive shared E2E key if configured
    if (this.e2e && this.config.gatewayPrivateKey && this.config.peerPublicKey) {
      await this.e2e.deriveSharedKey(
        this.config.gatewayPrivateKey,
        this.config.peerPublicKey
      );
      console.log("[relay] E2E encryption enabled");
    }

    this.connect();
    console.log(`[relay] Connecting to ${this.config.relayUrl}`);
  }

  private connect(): void {
    if (this.closed) return;

    const url = `${this.config.relayUrl}/ws/gateway?room=${this.config.roomId}`;

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.roomSecret}`,
        },
      } as any);

      this.ws.addEventListener("open", () => {
        console.log("[relay] Connected to relay");
        this.reconnectAttempt = 0;

        // Notify gateway of relay connection (sends session state)
        if (this.connectHandler) {
          this.connectHandler(this.createSyntheticClient());
        }
      });

      this.ws.addEventListener("message", (event: MessageEvent) => {
        this.handleMessage(
          typeof event.data === "string" ? event.data : String(event.data)
        );
      });

      this.ws.addEventListener("close", (event: CloseEvent) => {
        console.log(
          `[relay] Disconnected (code=${event.code} reason=${event.reason || "none"})`
        );
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.addEventListener("error", (event: Event) => {
        console.warn("[relay] WebSocket error");
        // close event will follow, triggering reconnect
      });
    } catch (err) {
      console.error("[relay] Connection failed:", err);
      this.scheduleReconnect();
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    try {
      let message = JSON.parse(raw);

      // Decrypt E2E messages
      if (isE2EMessage(message) && this.e2e?.isReady) {
        const plaintext = await this.e2e.decrypt(message.ciphertext, message.nonce);
        message = JSON.parse(plaintext);
      }

      const envelope = message as MessageEnvelope;
      const type = envelope.type as ActionType;
      const schema = ACTION_PAYLOAD_SCHEMAS[type];

      if (!schema) {
        // Not an action — might be something else, ignore
        return;
      }

      const validated = schema.safeParse(envelope.payload);
      if (!validated.success) {
        console.warn(
          `[relay] Invalid payload for ${type}: ${validated.error.message}`
        );
        return;
      }

      if (this.actionHandler) {
        this.actionHandler(
          this.relayClientId,
          type,
          validated.data,
          envelope.seq,
          envelope.sessionId
        );
      }
    } catch (err) {
      console.warn(`[relay] Failed to parse message: ${err}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    const base = RELAY_RECONNECT_BASE_MS;
    const max = RELAY_RECONNECT_MAX_MS;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempt), max);
    const jitter = delay * 0.25 * Math.random();
    const totalMs = delay + jitter;

    console.log(
      `[relay] Reconnecting in ${Math.round(totalMs)}ms (attempt ${this.reconnectAttempt + 1})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.connect();
    }, totalMs);
  }

  /**
   * Broadcast a message through the relay to all connected iOS clients.
   */
  broadcast(type: string, payload: unknown, sessionId: string | null): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const seq = ++this.seqCounter;
    const envelope = createEnvelope(type, payload, sessionId, seq);

    if (this.e2e?.isReady) {
      // Encrypt and send E2E wrapped message
      this.e2e.encrypt(JSON.stringify(envelope)).then(({ ciphertext, nonce }) => {
        const wire: E2EWireMessage = {
          e2e: true,
          nonce,
          ciphertext,
          hint: {
            type,
            toolName: (payload as any)?.toolName,
            risk: (payload as any)?.riskLevel,
          },
        };
        try {
          this.ws?.send(JSON.stringify(wire));
        } catch {
          console.warn("[relay] Failed to send encrypted broadcast");
        }
      }).catch(err => {
        console.error("[relay] Encryption failed:", err);
      });
    } else {
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch {
        console.warn("[relay] Failed to send broadcast");
      }
    }
  }

  /**
   * Send a message to the relay (same as broadcast for relay transport,
   * since the relay forwards to all connected clients).
   */
  send(type: string, payload: unknown, sessionId: string | null = null): void {
    this.broadcast(type, payload, sessionId);
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Gateway shutting down");
      this.ws = null;
    }
    console.log("[relay] Transport stopped");
  }

  /**
   * Create a synthetic WSClient for the connect handler.
   * This allows the gateway to send session state through the relay
   * when the relay connection is established.
   */
  private createSyntheticClient(): WSClient {
    const self = this;
    return {
      id: this.relayClientId,
      authenticated: true,
      lastSeq: 0,
      lastPong: Date.now(),
      clientSeq: 0,
      // Proxy ws.send() to relay transport
      ws: {
        send(data: string) {
          if (self.ws && self.ws.readyState === WebSocket.OPEN) {
            self.ws.send(data);
          }
        },
        close() {},
        data: { clientId: self.relayClientId },
      } as any,
    };
  }
}
