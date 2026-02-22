import type { ServerWebSocket } from "bun";
import type { MessageEnvelope } from "@agentpager/protocol";
import {
  createEnvelope,
  ACTION_PAYLOAD_SCHEMAS,
  HEARTBEAT_INTERVAL_MS,
  type ActionType,
  type HeartbeatPayload,
} from "@agentpager/protocol";
import type { GatewayConfig } from "../config.js";
import { MAX_WS_MESSAGE_BYTES, MAX_CLIENTS } from "../limits.js";
import { secureCompare } from "../security/auth.js";

export interface WSClient {
  ws: ServerWebSocket<WSClientData>;
  id: string;
  authenticated: boolean;
  lastSeq: number;
  lastPong: number;
  clientSeq: number;
}

export interface WSClientData {
  clientId: string;
}

export type ActionHandler = (
  clientId: string,
  type: ActionType,
  payload: unknown,
  seq: number,
  sessionId?: string | null
) => void;

export type ConnectHandler = (client: WSClient) => void;

type BunServer = ReturnType<typeof Bun.serve<WSClientData>>;

export class WebSocketTransport {
  private clients = new Map<string, WSClient>();
  private server: BunServer | null = null;
  private unixServer: BunServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private actionHandler: ActionHandler | null = null;
  private connectHandler: ConnectHandler | null = null;
  private seqCounter = 0;
  constructor(private config: GatewayConfig) {}

  onAction(handler: ActionHandler): void {
    this.actionHandler = handler;
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandler = handler;
  }

  async start(): Promise<void> {
    this.startLocalServer();
    await this.startLanServer();
    this.startHeartbeat();
  }

  private startLocalServer(): void {
    const socketPath = this.config.dataDir + "/gateway.sock";

    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(socketPath);
    } catch {
      // Doesn't exist
    }

    const self = this;

    this.unixServer = Bun.serve<WSClientData>({
      unix: socketPath,
      fetch(req, server) {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/ws") {
          const clientId = crypto.randomUUID();
          const upgraded = server.upgrade(req, { data: { clientId } });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }
        if (url.pathname === "/api/approve" && req.method === "POST") {
          return self.handleRestAction(req, "approve");
        }
        if (url.pathname === "/api/deny" && req.method === "POST") {
          return self.handleRestAction(req, "deny");
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          self.onOpen(ws, true);
        },
        message(ws, message) {
          self.onMessage(ws, message);
        },
        close(ws, code, reason) {
          self.onClose(ws, code, String(reason ?? ""));
        },
        maxPayloadLength: MAX_WS_MESSAGE_BYTES,
      },
    });

    try {
      const { chmodSync } = require("node:fs");
      chmodSync(socketPath, 0o600);
    } catch {
      // Best effort
    }

    console.log(`[ws] Local Unix socket at ${socketPath}`);
  }

  private async startLanServer(): Promise<void> {
    const self = this;

    // Check port availability (Bun.serve throws uncatchable native errors)
    const available = await new Promise<boolean>((resolve) => {
      const net = require("node:net");
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      // Use the configured bind host (default: 127.0.0.1, opt-in: 0.0.0.0 for LAN).
      // SECURITY: 0.0.0.0 exposes the server to all network interfaces.
      // Only use 0.0.0.0 when LAN access is needed (e.g., iOS app on same WiFi).
      // Set via AGENTPAGER_BIND_HOST env var or bind_host in config.toml.
      server.listen(this.config.wsPort, this.config.bindHost);
    });

    if (!available) {
      throw new Error(
        `Port ${this.config.wsPort} already in use. Stop the other process or change ws_port in config.toml`
      );
    }

    this.server = Bun.serve<WSClientData>({
      port: this.config.wsPort,
      hostname: this.config.bindHost,
      fetch(req, server) {
        const url = new URL(req.url, "http://localhost");

        if (url.pathname === "/test") {
          return new Response(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>AgentPager Test</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui;padding:20px;font-size:16px}
pre{background:#1e293b;padding:12px;border-radius:8px;overflow-x:auto;font-size:14px;white-space:pre-wrap}
.ok{color:#4ade80}.err{color:#f87171}.warn{color:#fbbf24}</style></head>
<body><h2>AgentPager Diagnostic</h2><pre id="log">Starting...\n</pre>
<script>
var log=document.getElementById('log');
function l(msg,cls){log.textContent+=msg+'\\n';}
try{
  var proto=location.protocol==='https:'?'wss:':'ws:';
  var wsUrl=proto+'//'+location.host+'/ws';
  l('Connecting to '+wsUrl+'...');
  var ws=new WebSocket(wsUrl);
  ws.onopen=function(){l('WebSocket OPEN');};
  ws.onmessage=function(e){l('MSG: '+e.data.substring(0,300));};
  ws.onclose=function(e){l('CLOSED: code='+e.code+' reason='+e.reason);};
  ws.onerror=function(){l('WS ERROR');};
}catch(e){l('Exception: '+e);}
</script></body></html>`, { headers: { "Content-Type": "text/html" } });
        }

        if (url.pathname === "/ws") {
          const clientId = crypto.randomUUID();
          const upgraded = server.upgrade(req, { data: { clientId } });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }

        if (url.pathname === "/api/approve" && req.method === "POST") {
          return self.handleRestAction(req, "approve");
        }
        if (url.pathname === "/api/deny" && req.method === "POST") {
          return self.handleRestAction(req, "deny");
        }
        if (url.pathname === "/api/health") {
          return Response.json({ status: "ok", clients: self.clients.size });
        }

        // Serve built client (static files + SPA fallback)
        return self.serveClient(url.pathname);
      },
      websocket: {
        open(ws) {
          self.onOpen(ws, false);
        },
        message(ws, message) {
          self.onMessage(ws, message);
        },
        close(ws, code, reason) {
          self.onClose(ws, code, String(reason ?? ""));
        },
        maxPayloadLength: MAX_WS_MESSAGE_BYTES,
      },
    });

    console.log(`[ws] LAN server on ${this.config.bindHost}:${this.config.wsPort}`);
  }

  private onOpen(ws: ServerWebSocket<WSClientData>, isLocal: boolean): void {
    if (this.clients.size >= MAX_CLIENTS) {
      ws.close(1013, "Max clients reached");
      return;
    }

    // MVP: auto-authenticate all clients (proper mTLS + TOTP pairing is Phase 2)
    const client: WSClient = {
      ws,
      id: ws.data.clientId,
      authenticated: true,
      lastSeq: 0,
      lastPong: Date.now(),
      clientSeq: 0,
    };

    this.clients.set(client.id, client);
    console.log(
      `[ws] Client connected: ${client.id} (${isLocal ? "local" : "LAN"})`
    );

    // Let the gateway send the full session state to the new client
    if (this.connectHandler) {
      this.connectHandler(client);
    } else {
      this.send(client, "session_list", { sessions: [] });
    }
  }

  private onMessage(
    ws: ServerWebSocket<WSClientData>,
    message: string | Buffer
  ): void {
    const client = this.clients.get(ws.data.clientId);
    if (!client) return;

    client.lastPong = Date.now();

    try {
      const raw =
        typeof message === "string" ? message : message.toString("utf-8");
      const envelope = JSON.parse(raw) as MessageEnvelope;

      const type = envelope.type as ActionType;
      const schema = ACTION_PAYLOAD_SCHEMAS[type];
      if (!schema) {
        this.sendError(client, `Unknown action type: ${type}`);
        return;
      }

      const parsed = schema.safeParse(envelope.payload);
      if (!parsed.success) {
        this.sendError(client, `Invalid payload for ${type}: ${parsed.error.message}`);
        return;
      }

      if (!client.authenticated && type !== "auth") {
        this.sendError(client, "Not authenticated");
        return;
      }

      if (type === "auth") {
        const { token } = parsed.data as { token: string };
        if (secureCompare(token, this.config.hookToken)) {
          client.authenticated = true;
          this.send(client, "auth_ok", { clientId: client.id });
        } else {
          this.sendError(client, "Invalid token");
          ws.close(1008, "Invalid token");
        }
        return;
      }

      client.clientSeq = envelope.seq;

      if (this.actionHandler) {
        this.actionHandler(client.id, type, parsed.data, envelope.seq, envelope.sessionId);
      }
    } catch (err) {
      this.sendError(client, `Parse error: ${String(err)}`);
    }
  }

  private onClose(ws: ServerWebSocket<WSClientData>, code: number, reason: string): void {
    const clientId = ws.data.clientId;
    this.clients.delete(clientId);
    console.log(`[ws] Client disconnected: ${clientId} (code=${code} reason=${reason || "none"})`);
  }

  broadcast(type: string, payload: unknown, sessionId: string | null): void {
    const seq = ++this.seqCounter;
    const envelope = createEnvelope(type, payload, sessionId, seq);
    const json = JSON.stringify(envelope);

    for (const client of this.clients.values()) {
      if (client.authenticated) {
        try {
          client.ws.send(json);
          client.lastSeq = seq;
        } catch {
          // Client disconnected
        }
      }
    }
  }

  send(client: WSClient, type: string, payload: unknown, sessionId: string | null = null): void {
    const seq = ++this.seqCounter;
    const envelope = createEnvelope(type, payload, sessionId, seq);
    try {
      client.ws.send(JSON.stringify(envelope));
      client.lastSeq = seq;
    } catch {
      // Client disconnected
    }
  }

  private sendError(client: WSClient, message: string): void {
    this.send(client, "error", {
      message,
      code: "PROTOCOL_ERROR",
      recoverable: true,
    });
  }

  private async handleRestAction(
    req: Request,
    action: "approve" | "deny"
  ): Promise<Response> {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const requestId = body.requestId as string;
      if (!requestId) {
        return Response.json({ error: "Missing requestId" }, { status: 400 });
      }

      if (this.actionHandler) {
        this.actionHandler("rest", action, body, 0);
      }

      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
  }

  private async serveClient(_pathname: string): Promise<Response> {
    return new Response(
      `<!DOCTYPE html>
<html><head><title>AgentPager</title></head>
<body><h1>AgentPager Gateway</h1><p>Use the AgentPager iOS app to connect.</p></body>
</html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const payload: HeartbeatPayload = {
        serverTime: new Date().toISOString(),
        activeSessions: 0,
      };
      this.broadcast("heartbeat", payload, null);
    }, HEARTBEAT_INTERVAL_MS);
  }

  get currentSeq(): number {
    return this.seqCounter;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.server?.stop(true);
    this.unixServer?.stop(true);
    for (const client of this.clients.values()) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
    console.log("[ws] Transport stopped");
  }
}
