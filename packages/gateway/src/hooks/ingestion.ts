import type { GatewayConfig } from "../config.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { NormalizedHookEvent } from "../adapters/base.js";
import { MAX_HOOK_PAYLOAD_BYTES } from "../limits.js";
import { secureCompare } from "../security/auth.js";

/**
 * Callback for when a hook event is received and normalized.
 */
export type HookEventHandler = (
  event: NormalizedHookEvent,
  agentName: string,
  respond: (result: { blocked: boolean; reason?: string }) => void,
  signal?: AbortSignal
) => void;

type BunHTTPServer = ReturnType<typeof Bun.serve>;

/**
 * Hook ingestion server — receives hook events from agent hook scripts.
 *
 * Two transports:
 * 1. HTTP POST on localhost:7890 (backward compat with Agent Pager)
 * 2. Unix socket at ~/.agentpager/hook.sock (new fast path, ~2ms)
 */
export class HookIngestion {
  private httpServer: BunHTTPServer | null = null;
  private unixServer: BunHTTPServer | null = null;
  private handler: HookEventHandler | null = null;

  constructor(
    private config: GatewayConfig,
    private adapters: AdapterRegistry
  ) {}

  /**
   * Set the handler for incoming hook events.
   */
  onEvent(handler: HookEventHandler): void {
    this.handler = handler;
  }

  /**
   * Start both HTTP and Unix socket servers.
   */
  async start(): Promise<void> {
    await this.startHttpServer();
    this.startUnixServer();
  }

  private async startHttpServer(): Promise<void> {
    const self = this;

    // Check if port is available before calling Bun.serve (which throws uncatchable native errors)
    const available = await new Promise<boolean>((resolve) => {
      const net = require("node:net");
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(this.config.hookHttpPort, "127.0.0.1");
    });

    if (!available) {
      console.warn(
        `[hooks] Port ${this.config.hookHttpPort} already in use (Agent Pager running?). ` +
        `HTTP hook ingestion disabled — Unix socket still active.`
      );
      return;
    }

    this.httpServer = Bun.serve({
      port: this.config.hookHttpPort,
      hostname: "127.0.0.1",
      async fetch(req) {
        return self.handleHttpRequest(req);
      },
    });

    console.log(
      `[hooks] HTTP server listening on 127.0.0.1:${this.config.hookHttpPort}`
    );
  }

  private startUnixServer(): void {
    const socketPath =
      this.config.dataDir + "/hook.sock";

    // Remove stale socket file
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(socketPath);
    } catch {
      // Doesn't exist, that's fine
    }

    const self = this;

    this.unixServer = Bun.serve({
      unix: socketPath,
      async fetch(req) {
        return self.handleHttpRequest(req);
      },
    });

    // Set restrictive permissions on socket
    try {
      const { chmodSync } = require("node:fs");
      chmodSync(socketPath, 0o600);
    } catch {
      // Best effort
    }

    console.log(`[hooks] Unix socket listening at ${socketPath}`);
  }

  private async handleHttpRequest(req: Request): Promise<Response> {
    const url = new URL(req.url, "http://localhost");

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Only accept POST
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Validate auth token for HTTP (not required for Unix socket — OS-enforced)
    const isUnix = !url.port; // Unix socket URLs don't have a port
    if (!isUnix) {
      const token =
        req.headers.get("X-AgentPager-Token") ||
        req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token || !secureCompare(token, this.config.hookToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // Read body with size limit
    const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_HOOK_PAYLOAD_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Determine agent and hook endpoint from URL path
    // Routes: /hook/:agent/:endpoint or /notification (backward compat)
    const parts = url.pathname.split("/").filter(Boolean);

    let agentName = "claude"; // default
    let endpoint = "notification";

    if (parts[0] === "hook" && parts.length >= 3) {
      agentName = parts[1];
      endpoint = parts[2];
    } else if (parts[0] === "notification") {
      // Backward compat with Agent Pager
      agentName = "claude";
      endpoint = "Notification";
    } else if (parts[0] === "hook" && parts.length === 2) {
      // /hook/:endpoint (assumes Claude)
      endpoint = parts[1];
    }

    // Look up adapter
    const adapter = this.adapters.get(agentName);
    if (!adapter) {
      return Response.json({ error: `Unknown agent: ${agentName}` }, { status: 400 });
    }

    // Normalize the payload
    const event = adapter.normalizeHookPayload(payload, endpoint);
    if (!event) {
      return Response.json({ error: "Could not normalize payload" }, { status: 400 });
    }

    // For permission requests, block until approval
    if (event.type === "permission_request" && this.handler) {
      return new Promise<Response>((resolveHttp) => {
        let resolved = false;

        // Detect when the hook process disconnects (e.g., killed by agent timeout)
        // so we can clean up the blocker entry and not leave stale pending requests
        if (req.signal) {
          req.signal.addEventListener("abort", () => {
            if (!resolved) {
              console.warn(
                `[hooks] Hook connection aborted for ${event.toolName || "unknown"} — ` +
                `agent likely killed the hook (timeout?). Cleaning up.`
              );
              resolved = true;
              // Respond won't actually reach the hook, but calling it ensures
              // the blocker/gateway cleans up state
              resolveHttp(
                Response.json(
                  { blocked: true, reason: "Hook connection lost" },
                  { status: 200 }
                )
              );
            }
          });
        }

        this.handler!(event, agentName, (result) => {
          if (!resolved) {
            resolved = true;
            console.log(
              `[hooks] Permission result for ${event.toolName || "unknown"}: ${result.blocked ? "DENIED" : "APPROVED"}`
            );
            resolveHttp(
              Response.json(result, {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            );
          } else {
            console.warn(
              `[hooks] Permission result for ${event.toolName || "unknown"} arrived after connection was already closed`
            );
          }
        }, req.signal);
      });
    }

    // Non-blocking events
    console.log(`[hooks] Non-blocking event: ${endpoint} (agent=${agentName}, type=${event.type})`);
    if (this.handler) {
      this.handler(event, agentName, () => {});
    }

    return Response.json({ ok: true });
  }

  /**
   * Stop all servers.
   */
  stop(): void {
    this.httpServer?.stop(true);
    this.unixServer?.stop(true);
    console.log("[hooks] Servers stopped");
  }
}
