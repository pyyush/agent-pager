import { randomUUID } from "node:crypto";
import type { SessionStatus, SessionInfo } from "@agentpager/protocol";
import { TMUX_PREFIXES } from "@agentpager/protocol";
import { AgentPagerDB } from "../db/database.js";
import type { AgentAdapter } from "../adapters/base.js";
import { MAX_SESSIONS } from "../limits.js";

export interface SessionHandle {
  id: string;
  agent: string;
  adapter: AgentAdapter;
  tmuxSession: string;
  status: SessionStatus;
  /** Sequence counter for events in this session */
  seq: number;
  /** Last agent response broadcast (for dedup) */
  lastBroadcastText?: string;
}

/**
 * Session manager — creates, tracks, and manages agent sessions.
 * Each session maps to a tmux session and an agent adapter.
 */
export class SessionManager {
  private sessions = new Map<string, SessionHandle>();
  /** Maps agent's own session ID → gateway session ID */
  private agentSessionMap = new Map<string, string>();

  constructor(private db: AgentPagerDB) {}

  /**
   * Create a new session (does not start the agent yet).
   */
  create(
    adapter: AgentAdapter,
    task: string,
    cwd?: string
  ): SessionHandle {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `Max sessions (${MAX_SESSIONS}) reached. Stop existing sessions first.`
      );
    }

    const id = randomUUID();
    // Only generate a tmux session name when gateway launches the agent.
    // For hook-originated sessions, the real tmux name comes from the hook.
    const tmuxSession = `${TMUX_PREFIXES[adapter.name] || "dp"}-${id.slice(0, 8)}`;

    const handle: SessionHandle = {
      id,
      agent: adapter.name,
      adapter,
      tmuxSession,
      status: "created",
      seq: 0,
    };

    this.sessions.set(id, handle);

    this.db.createSession({
      id,
      agent: adapter.name,
      task,
      cwd: cwd || process.cwd(),
      tmuxSession,
      status: "created",
    });

    return handle;
  }

  /**
   * Transition session status.
   */
  setStatus(sessionId: string, status: SessionStatus): void {
    const handle = this.sessions.get(sessionId);
    if (handle) {
      handle.status = status;
    }
    this.db.updateSessionStatus(sessionId, status);
  }

  /**
   * Get session by gateway ID or agent session ID.
   */
  get(sessionId: string): SessionHandle | undefined {
    // Try direct lookup first (gateway ID)
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;

    // Try agent session ID mapping
    const mappedId = this.agentSessionMap.get(sessionId);
    if (mappedId) return this.sessions.get(mappedId);

    return undefined;
  }

  /**
   * Register a mapping from an agent's session ID to gateway session ID.
   */
  mapAgentSession(agentSessionId: string, gatewaySessionId: string): void {
    this.agentSessionMap.set(agentSessionId, gatewaySessionId);
  }

  /**
   * Find session by tmux session name.
   */
  findByTmux(tmuxSession: string): SessionHandle | undefined {
    for (const handle of this.sessions.values()) {
      if (handle.tmuxSession === tmuxSession) return handle;
    }
    return undefined;
  }

  /**
   * Get next sequence number for a session.
   */
  nextSeq(sessionId: string): number {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      // Fall back to DB
      return this.db.getLatestSeq(sessionId) + 1;
    }
    return ++handle.seq;
  }

  /**
   * List all active sessions.
   */
  listActive(): SessionHandle[] {
    console.log(`[sessions] listActive: map size=${this.sessions.size}`);
    for (const h of this.sessions.values()) {
      console.log(`[sessions]   ${h.id.slice(0, 8)}… status=${h.status} tmux=${h.tmuxSession}`);
    }
    return Array.from(this.sessions.values()).filter(
      (h) => !["done", "stopped", "error"].includes(h.status)
    );
  }

  /**
   * List all in-memory sessions (including recently finished ones).
   */
  listInMemory(): SessionHandle[] {
    return Array.from(this.sessions.values());
  }

  /**
   * List all sessions (including finished ones from DB).
   */
  listAll(): SessionInfo[] {
    const dbSessions = this.db.listSessions();
    return dbSessions.map((s) => this.db.sessionToInfo(s));
  }

  /**
   * Remove a session from the in-memory map (keeps DB record).
   */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Restore sessions from DB on startup (recovery).
   */
  restore(adapter: AgentAdapter, dbSession: { id: string; tmux_session: string | null; status: string; }): void {
    const seq = this.db.getLatestSeq(dbSession.id);
    this.sessions.set(dbSession.id, {
      id: dbSession.id,
      agent: adapter.name,
      adapter,
      tmuxSession: dbSession.tmux_session || "",
      status: dbSession.status as SessionStatus,
      seq,
    });
  }
}
