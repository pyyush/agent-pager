import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SessionInfo,
  SessionStatus,
  PermissionRequestPayload,
  RiskLevel,
} from "@agentpager/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DBSession {
  id: string;
  agent: string;
  agent_version: string;
  task: string;
  cwd: string;
  tmux_session: string | null;
  status: string;
  auto_approve: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  metadata: string;
}

export interface DBEvent {
  id: number;
  session_id: string;
  seq: number;
  event_type: string;
  payload: string;
  created_at: number;
}

export interface DBPendingApproval {
  request_id: string;
  session_id: string;
  tool: string;
  target: string;
  risk: string;
  payload: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

export interface DBTrustRule {
  id: number;
  tool: string;
  target_pattern: string | null;
  risk_max: string;
  scope: string;
  session_id: string | null;
  created_at: number;
}

export class AgentPagerDB {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.initialize();
  }

  private initialize(): void {
    const schemaPath = join(__dirname, "schema.sql");
    const raw = readFileSync(schemaPath, "utf-8");

    // Strip single-line comments before splitting
    const noComments = raw.replace(/--.*$/gm, "");

    // Split into statements, respecting BEGIN...END blocks (triggers)
    const statements: string[] = [];
    let buf = "";
    let depth = 0;

    for (const part of noComments.split(";")) {
      buf += (buf ? ";" : "") + part;
      const begins = (part.match(/\bBEGIN\b/gi) || []).length;
      const ends = (part.match(/\bEND\b/gi) || []).length;
      depth += begins - ends;

      if (depth <= 0) {
        const stmt = buf.trim();
        if (stmt) statements.push(stmt);
        buf = "";
        depth = 0;
      }
    }
    if (buf.trim()) statements.push(buf.trim());

    for (const stmt of statements) {
      try {
        this.db.run(stmt);
      } catch (err) {
        const msg = String(err);
        if (!msg.includes("already exists")) {
          console.warn(`[db] Schema statement warning:`, err);
        }
      }
    }
  }

  // ── Sessions ────────────────────────────────────────────────────────

  createSession(session: {
    id: string;
    agent: string;
    agentVersion?: string;
    task?: string;
    cwd?: string;
    tmuxSession?: string;
    status?: SessionStatus;
    metadata?: Record<string, unknown>;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions (id, agent, agent_version, task, cwd, tmux_session, status, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.agent,
        session.agentVersion ?? "",
        session.task ?? "",
        session.cwd ?? "",
        session.tmuxSession ?? null,
        session.status ?? "created",
        now,
        now,
        JSON.stringify(session.metadata ?? {}),
      ]
    );
  }

  getSession(id: string): DBSession | null {
    return this.db
      .query<DBSession, [string]>("SELECT * FROM sessions WHERE id = ?")
      .get(id);
  }

  listSessions(activeOnly = false): DBSession[] {
    if (activeOnly) {
      return this.db
        .query<DBSession, []>(
          "SELECT * FROM sessions WHERE status IN ('created', 'running', 'waiting') ORDER BY created_at DESC"
        )
        .all();
    }
    return this.db
      .query<DBSession, []>("SELECT * FROM sessions ORDER BY created_at DESC")
      .all();
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    const now = Date.now();
    const finishedAt = ["done", "stopped", "error"].includes(status)
      ? now
      : null;
    this.db.run(
      `UPDATE sessions SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
      [status, now, finishedAt, id]
    );
  }

  updateSessionField(
    id: string,
    field: "task" | "cwd" | "tmux_session" | "metadata",
    value: string
  ): void {
    // Parameterized field name via allowlist
    const allowed = ["task", "cwd", "tmux_session", "metadata"];
    if (!allowed.includes(field)) throw new Error(`Invalid field: ${field}`);
    this.db.run(`UPDATE sessions SET ${field} = ?, updated_at = ? WHERE id = ?`, [
      value,
      Date.now(),
      id,
    ]);
  }

  // ── Events ──────────────────────────────────────────────────────────

  insertEvent(
    sessionId: string,
    seq: number,
    eventType: string,
    payload: unknown
  ): number {
    const result = this.db.run(
      `INSERT INTO events (session_id, seq, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, seq, eventType, JSON.stringify(payload), Date.now()]
    );
    return Number(result.lastInsertRowid);
  }

  getEventsSince(
    sessionId: string,
    afterSeq: number,
    limit = 1000
  ): DBEvent[] {
    return this.db
      .query<DBEvent, [string, number, number]>(
        "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
      )
      .all(sessionId, afterSeq, limit);
  }

  getLatestSeq(sessionId: string): number {
    const row = this.db
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(seq) as max_seq FROM events WHERE session_id = ?"
      )
      .get(sessionId);
    return row?.max_seq ?? 0;
  }

  searchEvents(query: string, sessionId?: string): DBEvent[] {
    // Quote the query to prevent FTS5 operator interpretation (e.g. hyphens as NOT)
    const quoted = `"${query.replace(/"/g, '""')}"`;
    if (sessionId) {
      return this.db
        .query<DBEvent, [string, string]>(
          `SELECT e.* FROM events e
           JOIN events_fts f ON e.id = f.rowid
           WHERE f.payload MATCH ? AND e.session_id = ?
           ORDER BY e.seq DESC LIMIT 100`
        )
        .all(quoted, sessionId);
    }
    return this.db
      .query<DBEvent, [string]>(
        `SELECT e.* FROM events e
         JOIN events_fts f ON e.id = f.rowid
         WHERE f.payload MATCH ?
         ORDER BY e.created_at DESC LIMIT 100`
      )
      .all(quoted);
  }

  // ── Pending Approvals ───────────────────────────────────────────────

  createPendingApproval(approval: {
    requestId: string;
    sessionId: string;
    tool: string;
    target: string;
    risk: RiskLevel;
    payload: PermissionRequestPayload;
  }): void {
    this.db.run(
      `INSERT INTO pending_approvals (request_id, session_id, tool, target, risk, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        approval.requestId,
        approval.sessionId,
        approval.tool,
        approval.target,
        approval.risk,
        JSON.stringify(approval.payload),
        Date.now(),
      ]
    );
  }

  getPendingApproval(requestId: string): DBPendingApproval | null {
    return this.db
      .query<DBPendingApproval, [string]>(
        "SELECT * FROM pending_approvals WHERE request_id = ? AND resolved_at IS NULL"
      )
      .get(requestId);
  }

  getPendingApprovalsForSession(sessionId: string): DBPendingApproval[] {
    return this.db
      .query<DBPendingApproval, [string]>(
        "SELECT * FROM pending_approvals WHERE session_id = ? AND resolved_at IS NULL ORDER BY created_at ASC"
      )
      .all(sessionId);
  }

  resolveApproval(requestId: string, resolution: string): void {
    this.db.run(
      "UPDATE pending_approvals SET resolved_at = ?, resolution = ? WHERE request_id = ?",
      [Date.now(), resolution, requestId]
    );
  }

  countPendingForSession(sessionId: string): number {
    const row = this.db
      .query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM pending_approvals WHERE session_id = ? AND resolved_at IS NULL"
      )
      .get(sessionId);
    return row?.cnt ?? 0;
  }

  // ── Trust Rules ─────────────────────────────────────────────────────

  addTrustRule(rule: {
    tool: string;
    targetPattern?: string;
    riskMax: RiskLevel;
    scope: "session" | "global";
    sessionId?: string;
  }): void {
    this.db.run(
      `INSERT INTO trust_rules (tool, target_pattern, risk_max, scope, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        rule.tool,
        rule.targetPattern ?? null,
        rule.riskMax,
        rule.scope,
        rule.sessionId ?? null,
        Date.now(),
      ]
    );
  }

  checkTrustRule(
    tool: string,
    target: string,
    risk: RiskLevel,
    sessionId: string
  ): boolean {
    const riskOrder: Record<string, number> = {
      safe: 0,
      moderate: 1,
      dangerous: 2,
    };

    // Check session-scoped rules first, then global
    const rules = this.db
      .query<DBTrustRule, [string, string]>(
        `SELECT * FROM trust_rules
         WHERE tool = ? AND (session_id = ? OR scope = 'global')
         ORDER BY scope ASC`
      )
      .all(tool, sessionId);

    for (const rule of rules) {
      // Check risk level
      if (riskOrder[risk] > riskOrder[rule.risk_max]) continue;

      // Check target pattern (null = match all)
      if (rule.target_pattern) {
        try {
          const regex = new RegExp(rule.target_pattern);
          if (!regex.test(target)) continue;
        } catch {
          continue;
        }
      }

      return true; // Trust rule matches
    }

    return false;
  }

  clearSessionTrustRules(sessionId: string): void {
    this.db.run(
      "DELETE FROM trust_rules WHERE session_id = ?",
      [sessionId]
    );
  }

  // ── Devices ─────────────────────────────────────────────────────────

  addDevice(device: {
    id: string;
    name: string;
    publicKey: string;
    fingerprint: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO devices (id, name, public_key, fingerprint, paired_at, last_seen, revoked)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [device.id, device.name, device.publicKey, device.fingerprint, now, now]
    );
  }

  getDevice(id: string): {
    id: string;
    name: string;
    public_key: string;
    fingerprint: string;
    paired_at: number;
    last_seen: number;
    revoked: number;
  } | null {
    return this.db
      .query("SELECT * FROM devices WHERE id = ? AND revoked = 0")
      .get(id) as ReturnType<typeof this.getDevice>;
  }

  updateDeviceLastSeen(id: string): void {
    this.db.run("UPDATE devices SET last_seen = ? WHERE id = ?", [
      Date.now(),
      id,
    ]);
  }

  revokeDevice(id: string): void {
    this.db.run("UPDATE devices SET revoked = 1 WHERE id = ?", [id]);
  }

  listDevices(): Array<{
    id: string;
    name: string;
    fingerprint: string;
    paired_at: number;
    last_seen: number;
    revoked: number;
  }> {
    return this.db
      .query(
        "SELECT id, name, fingerprint, paired_at, last_seen, revoked FROM devices ORDER BY paired_at DESC"
      )
      .all() as ReturnType<typeof this.listDevices>;
  }

  // ── Utilities ───────────────────────────────────────────────────────

  sessionToInfo(row: DBSession): SessionInfo {
    return {
      id: row.id,
      agent: row.agent,
      agentVersion: row.agent_version,
      task: row.task,
      cwd: row.cwd,
      status: row.status as SessionStatus,
      tmuxSession: row.tmux_session ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pendingApprovals: this.countPendingForSession(row.id),
    };
  }

  close(): void {
    this.db.close();
  }
}
