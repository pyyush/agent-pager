import type {
  PermissionRequestPayload,
  SessionStartPayload,
  SessionEndPayload,
  SessionUpdatePayload,
  ToolCompletePayload,
  MessagePayload,
  ActionType,
} from "@agentpager/protocol";
import {
  classifyRisk,
  summarizeTool,
  extractTarget,
  APPROVAL_TIMEOUT_MS,
  DANGEROUS_DELAY_MS,
} from "@agentpager/protocol";
import type { GatewayConfig } from "./config.js";
import { dbPath } from "./config.js";
import { AgentPagerDB } from "./db/database.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { SessionManager, type SessionHandle } from "./sessions/manager.js";
import { HookIngestion } from "./hooks/ingestion.js";
import { ApprovalBlocker, type BlockerResult } from "./hooks/blocker.js";
import { WebSocketTransport } from "./transport/websocket.js";
import { RelayTransport } from "./transport/relay.js";
import { generateDiff } from "./diff/generator.js";
import { loadOrCreateKeys } from "./security/keys.js";
import { recoverSessions } from "./health/recovery.js";
import { checkHealth } from "./health/check.js";
import { createTmuxSession, killTmuxSession, interruptTmux, sendToTmux, captureTmuxPane } from "./sessions/tmux.js";
import type { NormalizedHookEvent } from "./adapters/base.js";

/**
 * Gateway — the main orchestrator.
 *
 * Wires together: hook ingestion → adapter normalization → diff generation →
 * risk classification → WebSocket broadcast → approval blocking → hook response.
 */
export class Gateway {
  private db: AgentPagerDB;
  private adapters: AdapterRegistry;
  private sessions: SessionManager;
  private hooks: HookIngestion;
  private blocker: ApprovalBlocker;
  private transport: WebSocketTransport;
  private relay: RelayTransport | null = null;

  constructor(private config: GatewayConfig) {
    this.db = new AgentPagerDB(dbPath(config));
    this.adapters = new AdapterRegistry();
    this.sessions = new SessionManager(this.db);
    this.hooks = new HookIngestion(config, this.adapters);
    this.blocker = new ApprovalBlocker();
    this.transport = new WebSocketTransport(config);

    // Create relay transport if configured
    if (config.relayEnabled && config.relayRoomId && config.relayRoomSecret) {
      this.relay = new RelayTransport({
        relayUrl: config.relayUrl,
        roomId: config.relayRoomId,
        roomSecret: config.relayRoomSecret,
      });
    }
  }

  /**
   * Start the gateway daemon.
   */
  async start(): Promise<void> {
    console.log("[gateway] Starting AgentPager gateway...");

    // Generate/load keys
    loadOrCreateKeys(this.config.dataDir);

    // Detect installed agents
    const agents = await this.adapters.detectAll();
    for (const { adapter, version, compatible } of agents) {
      if (version) {
        console.log(
          `[gateway] Found ${adapter.displayName} v${version} ${compatible ? "(compatible)" : "(UNSUPPORTED)"}`
        );
      }
    }

    // Recover sessions from previous run
    const { restored, cleaned } = await recoverSessions(
      this.db,
      this.sessions,
      this.adapters
    );
    if (restored > 0 || cleaned > 0) {
      console.log(
        `[gateway] Recovery: ${restored} restored, ${cleaned} cleaned`
      );
    }

    // Wire up hook events
    this.hooks.onEvent((event, agentName, respond, signal) => {
      this.handleHookEvent(event, agentName, respond, signal);
    });

    // Wire up client actions
    this.transport.onAction((clientId, type, payload, seq, sessionId) => {
      this.handleClientAction(clientId, type, payload, seq, sessionId ?? undefined);
    });

    // Wire up new client connections — send full state
    this.transport.onConnect((client) => {
      this.handleNewClient(client);
    });

    // Start servers
    await this.hooks.start();
    await this.transport.start();

    // Start relay transport if configured
    if (this.relay) {
      this.relay.onAction((clientId, type, payload, seq, sessionId) => {
        this.handleClientAction(clientId, type, payload, seq, sessionId ?? undefined);
      });
      this.relay.onConnect((client) => {
        this.handleNewClient(client);
      });
      await this.relay.start();
      console.log("[gateway] Relay transport enabled");
    }

    console.log("[gateway] AgentPager gateway ready");
  }

  /**
   * Send full state to a newly connected client (session list + pending approvals).
   */
  private handleNewClient(client: import("./transport/websocket.js").WSClient): void {
    // Send only active sessions — stopped/done sessions are stale
    const activeSessions = this.sessions.listActive();
    const dbSessions = this.db.listSessions();
    const sessionList = activeSessions.map((s) => {
      const dbInfo = dbSessions.find((d) => d.id === s.id);
      return {
        id: s.id,
        agent: s.agent,
        agentVersion: this.adapters.getVersion(s.agent) || "",
        task: dbInfo?.task || "",
        cwd: dbInfo?.cwd || "",
        status: s.status,
        tmuxSession: s.tmuxSession,
        createdAt: dbInfo?.created_at || Date.now(),
        updatedAt: dbInfo?.updated_at || Date.now(),
        pendingApprovals: 0,
      };
    });
    console.log(`[gateway] Sending session_list to new client: ${sessionList.length} sessions (${sessionList.map(s => s.id.slice(0, 8) + '=' + s.status).join(', ') || 'none'})`);
    this.transport.send(client, "session_list", { sessions: sessionList });

    // For each active session, replay session_start + any pending approvals
    for (const session of activeSessions) {
      const dbInfo = dbSessions.find((d) => d.id === session.id);
      this.transport.send(client, "session_start", {
        agent: session.agent,
        agentVersion: this.adapters.getVersion(session.agent) || "",
        task: dbInfo?.task || "",
        cwd: dbInfo?.cwd || "",
        tmuxSession: session.tmuxSession,
      }, session.id);

      // Send pending approvals
      const pendingApprovals = this.db.getPendingApprovalsForSession(session.id);
      for (const approval of pendingApprovals) {
        try {
          const payload = typeof approval.payload === "string"
            ? JSON.parse(approval.payload)
            : approval.payload;
          this.transport.send(client, "permission_request", payload, session.id);
        } catch {
          // Skip malformed payloads
        }
      }
    }
  }

  /**
   * Handle an incoming hook event from an agent.
   * This is the critical path for the permission card flow.
   */
  private handleHookEvent(
    event: NormalizedHookEvent,
    agentName: string,
    respond: (result: { blocked: boolean; reason?: string }) => void,
    signal?: AbortSignal
  ): void {
    console.log(`[gateway] Hook event: type=${event.type} agent=${agentName} sessionId=${event.sessionId?.slice(0, 8) || "none"} tool=${event.toolName || "n/a"}`);

    // Find or create session
    let session = event.sessionId
      ? this.sessions.get(event.sessionId)
      : undefined;

    // If no session found by agent's session ID, try to find by agent name
    if (!session) {
      const activeSessions = this.sessions.listActive();
      session = activeSessions.find((s) => s.agent === agentName);
    }

    // Auto-create session if none exists
    if (!session) {
      const adapter = this.adapters.get(agentName);
      if (!adapter) {
        console.warn(`[gateway] Unknown agent: ${agentName}`);
        respond({ blocked: false });
        return;
      }
      const agentCwd = event.cwd || process.cwd();
      session = this.sessions.create(adapter, "", agentCwd);
      this.sessions.setStatus(session.id, "running");

      // Map agent's session ID to our session ID for future lookups
      if (event.sessionId) {
        this.sessions.mapAgentSession(event.sessionId, session.id);
        console.log(`[gateway] Mapped agent session ${event.sessionId.slice(0, 8)}… → ${session.id.slice(0, 8)}…`);
      }

      // Broadcast session start
      const startPayload: SessionStartPayload = {
        agent: agentName,
        agentVersion: this.adapters.getVersion(agentName) || "",
        task: "",
        cwd: agentCwd,
        tmuxSession: event.tmuxSession,
      };
      this.broadcastEvent("session_start", startPayload, session.id);
    } else if (event.sessionId) {
      // Ensure mapping exists even for existing sessions
      this.sessions.mapAgentSession(event.sessionId, session.id);
    }

    // Update tmux session name if provided by hook (for text_input support)
    if (event.tmuxSession) {
      if (!session.tmuxSession || session.tmuxSession !== event.tmuxSession) {
        console.log(`[gateway] Setting tmux session for ${session.id.slice(0, 8)}… → "${event.tmuxSession}"`);
        session.tmuxSession = event.tmuxSession;
        this.db.updateSessionField(session.id, "tmux_session", event.tmuxSession);
      }
    } else {
      console.log(`[gateway] Hook event has no tmuxSession (TMUX env not set in hook process?)`);
    }

    switch (event.type) {
      case "permission_request":
        this.handlePermissionRequest(session, event, respond, signal);
        break;

      case "tool_complete":
        this.handleToolComplete(session, event);
        respond({ blocked: false });
        break;

      case "notification":
        this.handleNotification(session, event);
        respond({ blocked: false });
        break;

      case "stop":
        this.handleStop(session);
        respond({ blocked: false });
        break;

      case "error":
        this.handleError(session, event);
        respond({ blocked: false });
        break;

      case "progress":
        respond({ blocked: false });
        break;

      default:
        respond({ blocked: false });
    }
  }

  /**
   * Handle a permission request — the core flow.
   */
  private async handlePermissionRequest(
    session: SessionHandle,
    event: NormalizedHookEvent,
    respond: (result: BlockerResult) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const toolName = event.toolName || "Unknown";
    const toolInput = event.toolInput || {};

    // AskUserQuestion: auto-approve and broadcast as a user_question event
    // so the iOS app can show interactive options instead of approve/deny
    if (toolName === "AskUserQuestion") {
      console.log(`[gateway] AskUserQuestion — auto-approving, broadcasting question card`);
      this.broadcastEvent("user_question", {
        sessionId: session.id,
        questions: toolInput.questions || [],
      }, session.id);
      this.sessions.setStatus(session.id, "waiting");
      respond({ blocked: false });
      return;
    }

    // Classify risk
    const risk = classifyRisk(toolName, toolInput);

    // Check auto-approve rules
    if (this.config.autoApproveSafe && risk === "safe") {
      respond({ blocked: false });
      return;
    }

    // Check trust rules
    const target = extractTarget(toolName, toolInput);
    if (this.db.checkTrustRule(toolName, target, risk, session.id)) {
      respond({ blocked: false });
      return;
    }

    // Generate diff for Write/Edit
    const diff = generateDiff(toolName, toolInput);

    // Build permission request payload
    const requestId = crypto.randomUUID();
    const permPayload: PermissionRequestPayload = {
      requestId,
      toolName,
      toolCategory: "unknown",
      toolInput,
      riskLevel: risk,
      summary: summarizeTool(toolName, toolInput),
      diff: diff || undefined,
      target,
      rawPayload: event.rawPayload,
    };

    console.log(
      `[gateway] Permission request: ${toolName} → ${target} (risk=${risk}, id=${requestId.slice(0, 8)}…, diff=${diff ? `${diff.hunks.length} hunks, +${diff.additions}/-${diff.deletions}` : "none"})`
    );

    // Persist to DB
    this.db.createPendingApproval({
      requestId,
      sessionId: session.id,
      tool: toolName,
      target,
      risk,
      payload: permPayload,
    });

    // Update session status to waiting
    this.sessions.setStatus(session.id, "waiting");

    // Broadcast to clients
    this.broadcastEvent("permission_request", permPayload, session.id);

    // If the hook process disconnects (killed by agent timeout), cancel the
    // blocker entry so stale approvals from the phone don't resolve a dead request
    if (signal) {
      signal.addEventListener("abort", () => {
        if (this.blocker.isPending(requestId)) {
          console.warn(
            `[gateway] Hook connection lost for ${toolName} (id=${requestId.slice(0, 8)}…) — cancelling blocker`
          );
          this.blocker.deny(requestId, "Hook connection lost");
        }
      });
    }

    // Block the hook until approval
    const result = await this.blocker.waitForApproval(
      requestId,
      session.id,
      this.config.approvalTimeoutMs
    );

    console.log(
      `[gateway] Permission resolved: ${toolName} → ${result.blocked ? "DENIED" : "APPROVED"} (id=${requestId.slice(0, 8)}…)`
    );

    // Resolve in DB
    this.db.resolveApproval(
      requestId,
      result.blocked ? "denied" : "approved"
    );

    // Update session status back to running
    if (!result.blocked) {
      this.sessions.setStatus(session.id, "running");
    }

    respond(result);
  }

  private handleToolComplete(
    session: SessionHandle,
    event: NormalizedHookEvent
  ): void {
    const payload: ToolCompletePayload = {
      toolName: event.toolName || "Unknown",
      toolInput: event.toolInput || {},
      toolOutput: event.toolOutput || "",
      success: true,
      duration: 0,
    };
    this.broadcastEvent("tool_complete", payload, session.id);
  }

  private handleNotification(
    session: SessionHandle,
    event: NormalizedHookEvent
  ): void {
    const text = event.message || "";
    console.log(`[gateway] Notification: message="${text.slice(0, 100)}"`);

    // Skip empty notifications and tool-completion echoes — those are
    // already covered by PostToolUse → handleToolComplete → tool_complete.
    // Claude Code fires Notification for system events like "Bash completed",
    // which would duplicate the tool_complete event.
    if (!text || text.length === 0) return;

    // Don't broadcast — agent text responses are captured via tmux pane
    // in handleStop. Notification hook does NOT fire for conversational
    // text responses anyway, only for system notifications which are
    // redundant with tool_complete events.
  }

  private async handleStop(session: SessionHandle): Promise<void> {
    // Claude Code's Stop hook fires after EVERY turn (agent pauses for input),
    // NOT only when the session ends. Treat it as "idle" — the session is still alive.
    console.log(`[gateway] Stop hook for ${session.id.slice(0, 8)}… — marking idle (not done)`);
    this.sessions.setStatus(session.id, "running");

    // Cancel any pending blockers (stale approval requests from this turn)
    this.blocker.cancelSession(session.id);

    // Capture tmux pane to extract agent's last text response
    // (Claude Code doesn't fire Notification hooks for text responses)
    if (session.tmuxSession) {
      try {
        const paneContent = await captureTmuxPane(session.tmuxSession, 50);
        const agentText = this.extractLastAgentResponse(paneContent);
        if (agentText && agentText !== session.lastBroadcastText) {
          session.lastBroadcastText = agentText;
          console.log(`[gateway] Agent response captured: "${agentText.slice(0, 80)}…"`);
          this.broadcastEvent("message", {
            role: "agent",
            text: agentText,
            isThinking: false,
          } as MessagePayload, session.id);
        }
      } catch (err) {
        console.warn(`[gateway] Failed to capture tmux pane: ${err}`);
      }
    }

    // Broadcast session update (not session_end)
    this.broadcastEvent("session_update", {
      status: "running",
    }, session.id);
  }

  /**
   * Extract the last agent response from tmux pane content.
   * Claude Code uses ⏺ as the response marker.
   */
  private extractLastAgentResponse(paneContent: string): string | null {
    const lines = paneContent.split("\n");

    // Find the last ⏺ marker (agent response start)
    let lastMarkerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("⏺")) {
        lastMarkerIdx = i;
        break;
      }
    }

    if (lastMarkerIdx === -1) return null;

    // Collect lines from the marker until we hit an empty line or prompt
    const responseLines: string[] = [];
    for (let i = lastMarkerIdx; i < lines.length; i++) {
      const line = lines[i];
      // Stop at the input prompt (❯ or >) or empty trailing lines
      if (i > lastMarkerIdx && (line.startsWith("❯") || line.startsWith("> "))) break;
      responseLines.push(line);
    }

    // Clean up: remove the ⏺ marker, trim
    let text = responseLines.join("\n")
      .replace(/⏺\s*/, "")
      .trim();

    // Skip if empty or looks like a tool use block
    if (!text || text.startsWith("Tool:") || text.startsWith("Running:")) return null;

    return text;
  }

  private handleError(
    session: SessionHandle,
    event: NormalizedHookEvent
  ): void {
    this.broadcastEvent(
      "error",
      {
        message: event.message || "Unknown error",
        code: "AGENT_ERROR",
        recoverable: true,
      },
      session.id
    );
  }

  /**
   * Handle a client action (approve, deny, start_session, etc.).
   */
  private async handleClientAction(
    clientId: string,
    type: ActionType,
    payload: unknown,
    _seq: number,
    sessionId?: string
  ): Promise<void> {
    const data = payload as Record<string, unknown>;

    switch (type) {
      case "approve": {
        const requestId = data.requestId as string;
        const scope = (data.scope as string) || "once";

        console.log(
          `[gateway] Client ${clientId.slice(0, 8)}… sent APPROVE for ${requestId.slice(0, 8)}… (scope=${scope})`
        );

        // For dangerous actions, apply delay
        const pending = this.db.getPendingApproval(requestId);
        if (pending?.risk === "dangerous") {
          await new Promise((r) => setTimeout(r, this.config.dangerousDelayMs));
          // Check if it was cancelled during the delay
          if (!this.blocker.isPending(requestId)) return;
        }

        const approved = this.blocker.approve(requestId);
        if (!approved) {
          console.warn(
            `[gateway] blocker.approve(${requestId.slice(0, 8)}…) returned false — request not in pending map (already resolved/timed out)`
          );
        }

        // Create trust rule if scope is broader than "once"
        if (scope !== "once" && pending) {
          this.db.addTrustRule({
            tool: pending.tool,
            targetPattern: scope === "tool" ? undefined : undefined,
            riskMax: pending.risk as "safe" | "moderate" | "dangerous",
            scope: scope === "session" ? "session" : "global",
            sessionId: scope === "session" ? pending.session_id : undefined,
          });
        }
        break;
      }

      case "deny": {
        const requestId = data.requestId as string;
        const reason = data.reason as string | undefined;
        console.log(
          `[gateway] Client ${clientId.slice(0, 8)}… sent DENY for ${requestId.slice(0, 8)}… (reason=${reason || "none"})`
        );
        this.blocker.deny(requestId, reason);
        break;
      }

      case "batch_approve": {
        const requestIds = data.requestIds as string[];
        for (const rid of requestIds) {
          this.blocker.approve(rid);
        }
        break;
      }

      case "text_input": {
        const text = data.text as string;
        console.log(`[gateway] text_input: "${text}" (sessionId=${sessionId || "none"})`);

        // Find the target session — prefer sessionId from the action, fall back to first active
        const targetSession = sessionId
          ? this.sessions.get(sessionId)
          : this.sessions.listActive()[0];

        console.log(`[gateway] text_input: target=${targetSession?.id?.slice(0, 8) || "none"}, tmux="${targetSession?.tmuxSession || "none"}"`);

        if (targetSession?.tmuxSession) {
          const sent = await sendToTmux(targetSession.tmuxSession, text);
          console.log(`[gateway] text_input: sendToTmux result=${sent}`);
        } else {
          console.warn(`[gateway] text_input: no tmux session — agent not running in tmux`);
        }
        break;
      }

      case "stop": {
        const force = data.force as boolean;
        // Target specific session if sessionId provided, else all active
        const targets = sessionId
          ? [this.sessions.get(sessionId)].filter(Boolean) as SessionHandle[]
          : this.sessions.listActive();

        for (const session of targets) {
          console.log(`[gateway] stop: session=${session.id.slice(0, 8)}… force=${force} tmux="${session.tmuxSession}"`);
          if (force) {
            await killTmuxSession(session.tmuxSession);
          } else {
            // Send /exit to gracefully quit Claude Code (Ctrl+C only cancels current operation)
            await sendToTmux(session.tmuxSession, "/exit");
          }
          this.sessions.setStatus(session.id, "stopped");
          this.blocker.cancelSession(session.id);
          this.broadcastEvent("session_end", { status: "stopped" }, session.id);
        }
        break;
      }

      case "pause": {
        const activeSessions = this.sessions.listActive();
        for (const session of activeSessions) {
          await interruptTmux(session.tmuxSession);
        }
        break;
      }

      case "start_session": {
        const agent = data.agent as string;
        const task = data.task as string;
        const cwd = data.cwd as string | undefined;

        const adapter = this.adapters.get(agent);
        if (!adapter) {
          console.warn(`[gateway] Unknown agent for start_session: ${agent}`);
          return;
        }

        const session = this.sessions.create(adapter, task, cwd);
        const cmd = adapter.buildLaunchCommand(task);

        const started = await createTmuxSession(
          session.tmuxSession,
          cmd,
          cwd
        );

        if (started) {
          this.sessions.setStatus(session.id, "running");
          const startPayload: SessionStartPayload = {
            agent: adapter.name,
            agentVersion: this.adapters.getVersion(agent) || "",
            task,
            cwd: cwd || process.cwd(),
            tmuxSession: session.tmuxSession,
          };
          this.broadcastEvent("session_start", startPayload, session.id);
        } else {
          this.sessions.setStatus(session.id, "error");
          this.broadcastEvent(
            "error",
            {
              message: `Failed to start ${adapter.displayName} session`,
              code: "SESSION_START_FAILED",
              recoverable: false,
            },
            session.id
          );
        }
        break;
      }

      case "resume_from_seq": {
        const lastSeq = data.lastSeq as number;
        // TODO: replay missed events from DB
        break;
      }

      default:
        console.warn(`[gateway] Unhandled action type: ${type}`);
    }
  }

  /**
   * Broadcast an event, persisting to DB and sending to all clients.
   */
  private broadcastEvent(
    type: string,
    payload: unknown,
    sessionId: string
  ): void {
    const seq = this.sessions.nextSeq(sessionId);
    this.db.insertEvent(sessionId, seq, type, payload);
    this.transport.broadcast(type, payload, sessionId);
    // Also broadcast through relay
    this.relay?.broadcast(type, payload, sessionId);
  }

  /**
   * Get a health check.
   */
  getHealth() {
    return checkHealth(
      this.config,
      this.transport.clientCount,
      this.sessions.listActive().length,
      this.blocker.size
    );
  }

  /**
   * Gracefully shut down the gateway.
   */
  async stop(): Promise<void> {
    console.log("[gateway] Shutting down...");
    this.hooks.stop();
    this.transport.stop();
    this.relay?.stop();
    this.db.close();
    console.log("[gateway] Goodbye");
  }
}
