/**
 * Database tests for AgentPagerDB.
 *
 * These tests require Bun runtime because AgentPagerDB uses `bun:sqlite`.
 * When running under Vitest (Node.js), the entire suite is skipped.
 * Run with `bun test` to execute these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const isBun = typeof globalThis.Bun !== "undefined";

// Conditionally import — will fail under Node.js but we skip the suite
const { AgentPagerDB } = isBun
  ? await import("../../src/db/database.js")
  : { AgentPagerDB: null as any };

describe.skipIf(!isBun)("AgentPagerDB", () => {
  let dbPath: string;
  let db: InstanceType<typeof AgentPagerDB>;

  beforeEach(async () => {
    const { unlinkSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    dbPath = join("/tmp", `agentpager-test-${process.pid}-${Date.now()}.db`);
    db = new AgentPagerDB(dbPath);
  });

  afterEach(async () => {
    const { unlinkSync, existsSync } = await import("node:fs");
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = dbPath + suffix;
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  });

  // ── Sessions ───────────────────────────────────────────────────────

  describe("sessions", () => {
    it("create and retrieve a session", () => {
      db.createSession({
        id: "sess-1",
        agent: "claude",
        agentVersion: "1.0.12",
        task: "Fix the auth bug",
        cwd: "/home/user/project",
        tmuxSession: "ap-cc-sess1",
      });

      const session = db.getSession("sess-1");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("sess-1");
      expect(session!.agent).toBe("claude");
      expect(session!.agent_version).toBe("1.0.12");
      expect(session!.task).toBe("Fix the auth bug");
      expect(session!.cwd).toBe("/home/user/project");
      expect(session!.tmux_session).toBe("ap-cc-sess1");
      expect(session!.status).toBe("created");
      expect(session!.created_at).toBeGreaterThan(0);
      expect(session!.updated_at).toBeGreaterThan(0);
    });

    it("returns null for non-existent session", () => {
      expect(db.getSession("nonexistent")).toBeNull();
    });

    it("uses defaults for optional fields", () => {
      db.createSession({ id: "sess-min", agent: "codex" });
      const session = db.getSession("sess-min");
      expect(session!.agent_version).toBe("");
      expect(session!.task).toBe("");
      expect(session!.cwd).toBe("");
      expect(session!.tmux_session).toBeNull();
      expect(session!.status).toBe("created");
    });

    it("update session status", () => {
      db.createSession({ id: "sess-2", agent: "claude" });

      db.updateSessionStatus("sess-2", "running");
      let session = db.getSession("sess-2");
      expect(session!.status).toBe("running");
      expect(session!.finished_at).toBeNull();

      db.updateSessionStatus("sess-2", "done");
      session = db.getSession("sess-2");
      expect(session!.status).toBe("done");
      expect(session!.finished_at).toBeGreaterThan(0);
    });

    it("terminal statuses set finished_at", () => {
      for (const status of ["done", "stopped", "error"] as const) {
        const id = `sess-${status}`;
        db.createSession({ id, agent: "claude" });
        db.updateSessionStatus(id, status);
        const session = db.getSession(id);
        expect(session!.finished_at).not.toBeNull();
      }
    });

    it("non-terminal statuses do not set finished_at", () => {
      for (const status of ["running", "waiting"] as const) {
        const id = `sess-${status}`;
        db.createSession({ id, agent: "claude" });
        db.updateSessionStatus(id, status);
        const session = db.getSession(id);
        expect(session!.finished_at).toBeNull();
      }
    });

    it("list sessions", () => {
      db.createSession({ id: "s1", agent: "claude", status: "running" });
      db.createSession({ id: "s2", agent: "codex", status: "done" });
      db.createSession({ id: "s3", agent: "gemini", status: "waiting" });

      db.updateSessionStatus("s1", "running");
      db.updateSessionStatus("s2", "done");
      db.updateSessionStatus("s3", "waiting");

      const all = db.listSessions();
      expect(all).toHaveLength(3);

      const active = db.listSessions(true);
      expect(active).toHaveLength(2);
      const activeIds = active.map((s: any) => s.id);
      expect(activeIds).toContain("s1");
      expect(activeIds).toContain("s3");
    });

    it("sessionToInfo converts DB row correctly", () => {
      db.createSession({
        id: "sess-info",
        agent: "claude",
        agentVersion: "1.0.0",
        task: "Test task",
        cwd: "/tmp",
        tmuxSession: "ap-cc-test",
      });
      const row = db.getSession("sess-info")!;
      const info = db.sessionToInfo(row);

      expect(info.id).toBe("sess-info");
      expect(info.agent).toBe("claude");
      expect(info.agentVersion).toBe("1.0.0");
      expect(info.task).toBe("Test task");
      expect(info.cwd).toBe("/tmp");
      expect(info.status).toBe("created");
      expect(info.tmuxSession).toBe("ap-cc-test");
      expect(info.pendingApprovals).toBe(0);
    });
  });

  // ── Events ─────────────────────────────────────────────────────────

  describe("events", () => {
    beforeEach(() => {
      db.createSession({ id: "sess-ev", agent: "claude" });
    });

    it("insert and retrieve events", () => {
      const id1 = db.insertEvent("sess-ev", 1, "permission_request", {
        toolName: "Bash",
        command: "ls",
      });
      const id2 = db.insertEvent("sess-ev", 2, "tool_complete", {
        toolName: "Bash",
        success: true,
      });

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);

      const events = db.getEventsSince("sess-ev", 0);
      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(1);
      expect(events[0].event_type).toBe("permission_request");
      expect(JSON.parse(events[0].payload)).toEqual({ toolName: "Bash", command: "ls" });
      expect(events[1].seq).toBe(2);
    });

    it("get events since a sequence number", () => {
      db.insertEvent("sess-ev", 1, "session_start", {});
      db.insertEvent("sess-ev", 2, "permission_request", {});
      db.insertEvent("sess-ev", 3, "tool_complete", {});
      db.insertEvent("sess-ev", 4, "permission_request", {});

      const since2 = db.getEventsSince("sess-ev", 2);
      expect(since2).toHaveLength(2);
      expect(since2[0].seq).toBe(3);
      expect(since2[1].seq).toBe(4);
    });

    it("get events since returns empty for no matches", () => {
      db.insertEvent("sess-ev", 1, "session_start", {});
      const events = db.getEventsSince("sess-ev", 100);
      expect(events).toHaveLength(0);
    });

    it("getLatestSeq returns max seq", () => {
      expect(db.getLatestSeq("sess-ev")).toBe(0);

      db.insertEvent("sess-ev", 1, "a", {});
      db.insertEvent("sess-ev", 2, "b", {});
      db.insertEvent("sess-ev", 5, "c", {});

      expect(db.getLatestSeq("sess-ev")).toBe(5);
    });

    it("getLatestSeq returns 0 for non-existent session", () => {
      expect(db.getLatestSeq("nonexistent")).toBe(0);
    });
  });

  // ── Pending Approvals ──────────────────────────────────────────────

  describe("pending approvals", () => {
    beforeEach(() => {
      db.createSession({ id: "sess-pa", agent: "claude" });
    });

    it("create and retrieve pending approval", () => {
      const payload = {
        requestId: "req-1",
        toolName: "Bash",
        toolCategory: "execute",
        toolInput: { command: "rm -rf /tmp/test" },
        riskLevel: "dangerous" as const,
        summary: "rm -rf /tmp/test",
        target: "rm -rf /tmp/test",
      };

      db.createPendingApproval({
        requestId: "req-1",
        sessionId: "sess-pa",
        tool: "Bash",
        target: "rm -rf /tmp/test",
        risk: "dangerous",
        payload,
      });

      const approval = db.getPendingApproval("req-1");
      expect(approval).not.toBeNull();
      expect(approval!.request_id).toBe("req-1");
      expect(approval!.session_id).toBe("sess-pa");
      expect(approval!.tool).toBe("Bash");
      expect(approval!.risk).toBe("dangerous");
      expect(approval!.resolved_at).toBeNull();
      expect(JSON.parse(approval!.payload)).toEqual(payload);
    });

    it("resolve pending approval", () => {
      db.createPendingApproval({
        requestId: "req-2",
        sessionId: "sess-pa",
        tool: "Write",
        target: "/tmp/test.txt",
        risk: "safe",
        payload: {
          requestId: "req-2",
          toolName: "Write",
          toolCategory: "write",
          toolInput: {},
          riskLevel: "safe" as const,
          summary: "Write",
          target: "/tmp/test.txt",
        },
      });

      db.resolveApproval("req-2", "approved");

      const approval = db.getPendingApproval("req-2");
      expect(approval).toBeNull();
    });

    it("countPendingForSession returns correct count", () => {
      expect(db.countPendingForSession("sess-pa")).toBe(0);

      db.createPendingApproval({
        requestId: "req-a",
        sessionId: "sess-pa",
        tool: "Bash",
        target: "ls",
        risk: "safe",
        payload: {
          requestId: "req-a",
          toolName: "Bash",
          toolCategory: "execute",
          toolInput: {},
          riskLevel: "safe" as const,
          summary: "ls",
          target: "ls",
        },
      });
      db.createPendingApproval({
        requestId: "req-b",
        sessionId: "sess-pa",
        tool: "Write",
        target: "/tmp/x",
        risk: "safe",
        payload: {
          requestId: "req-b",
          toolName: "Write",
          toolCategory: "write",
          toolInput: {},
          riskLevel: "safe" as const,
          summary: "Write",
          target: "/tmp/x",
        },
      });

      expect(db.countPendingForSession("sess-pa")).toBe(2);

      db.resolveApproval("req-a", "approved");
      expect(db.countPendingForSession("sess-pa")).toBe(1);
    });

    it("getPendingApprovalsForSession returns unresolved approvals", () => {
      db.createPendingApproval({
        requestId: "req-c",
        sessionId: "sess-pa",
        tool: "Bash",
        target: "echo",
        risk: "safe",
        payload: {
          requestId: "req-c",
          toolName: "Bash",
          toolCategory: "execute",
          toolInput: {},
          riskLevel: "safe" as const,
          summary: "echo",
          target: "echo",
        },
      });
      db.createPendingApproval({
        requestId: "req-d",
        sessionId: "sess-pa",
        tool: "Edit",
        target: "/tmp/y",
        risk: "safe",
        payload: {
          requestId: "req-d",
          toolName: "Edit",
          toolCategory: "write",
          toolInput: {},
          riskLevel: "safe" as const,
          summary: "Edit",
          target: "/tmp/y",
        },
      });

      const pending = db.getPendingApprovalsForSession("sess-pa");
      expect(pending).toHaveLength(2);

      db.resolveApproval("req-c", "denied");
      const remaining = db.getPendingApprovalsForSession("sess-pa");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].request_id).toBe("req-d");
    });
  });

  // ── Trust Rules ────────────────────────────────────────────────────

  describe("trust rules", () => {
    beforeEach(() => {
      db.createSession({ id: "sess-tr", agent: "claude" });
    });

    it("add and check matching session-scoped rule", () => {
      db.addTrustRule({
        tool: "Bash",
        riskMax: "safe",
        scope: "session",
        sessionId: "sess-tr",
      });

      const match = db.checkTrustRule("Bash", "echo hello", "safe", "sess-tr");
      expect(match).toBe(true);

      const noMatch = db.checkTrustRule("Bash", "curl example.com", "moderate", "sess-tr");
      expect(noMatch).toBe(false);
    });

    it("add and check global rule", () => {
      db.addTrustRule({
        tool: "Read",
        riskMax: "safe",
        scope: "global",
      });

      const match = db.checkTrustRule("Read", "/tmp/file", "safe", "sess-tr");
      expect(match).toBe(true);
    });

    it("target pattern matching", () => {
      db.addTrustRule({
        tool: "Write",
        targetPattern: "^/tmp/",
        riskMax: "safe",
        scope: "session",
        sessionId: "sess-tr",
      });

      expect(db.checkTrustRule("Write", "/tmp/test.txt", "safe", "sess-tr")).toBe(true);
      expect(db.checkTrustRule("Write", "/etc/hosts", "safe", "sess-tr")).toBe(false);
    });

    it("risk level ordering: dangerous > moderate > safe", () => {
      db.addTrustRule({
        tool: "Bash",
        riskMax: "moderate",
        scope: "session",
        sessionId: "sess-tr",
      });

      expect(db.checkTrustRule("Bash", "ls", "safe", "sess-tr")).toBe(true);
      expect(db.checkTrustRule("Bash", "curl x", "moderate", "sess-tr")).toBe(true);
      expect(db.checkTrustRule("Bash", "rm -rf /", "dangerous", "sess-tr")).toBe(false);
    });

    it("no matching rule returns false", () => {
      expect(db.checkTrustRule("Bash", "ls", "safe", "sess-tr")).toBe(false);
    });

    it("clearSessionTrustRules removes session rules", () => {
      db.addTrustRule({
        tool: "Bash",
        riskMax: "safe",
        scope: "session",
        sessionId: "sess-tr",
      });
      expect(db.checkTrustRule("Bash", "ls", "safe", "sess-tr")).toBe(true);

      db.clearSessionTrustRules("sess-tr");
      expect(db.checkTrustRule("Bash", "ls", "safe", "sess-tr")).toBe(false);
    });
  });

  // ── FTS5 Search ────────────────────────────────────────────────────

  describe("FTS5 search", () => {
    beforeEach(() => {
      db.createSession({ id: "sess-fts", agent: "claude" });
    });

    it("search finds events by payload content", () => {
      db.insertEvent("sess-fts", 1, "permission_request", {
        toolName: "Bash",
        command: "npm install express",
      });
      db.insertEvent("sess-fts", 2, "tool_complete", {
        toolName: "Write",
        file: "index.ts",
      });
      db.insertEvent("sess-fts", 3, "permission_request", {
        toolName: "Bash",
        command: "npm test",
      });

      const results = db.searchEvents("express");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(results[0].payload)).toHaveProperty("command", "npm install express");
    });

    it("search with sessionId filter", () => {
      db.createSession({ id: "sess-fts-2", agent: "codex" });

      db.insertEvent("sess-fts", 1, "message", { text: "unique-search-term-alpha" });
      db.insertEvent("sess-fts-2", 1, "message", {
        text: "unique-search-term-alpha also here",
      });

      const filtered = db.searchEvents("unique-search-term-alpha", "sess-fts");
      for (const event of filtered) {
        expect(event.session_id).toBe("sess-fts");
      }
    });

    it("search returns empty for no matches", () => {
      db.insertEvent("sess-fts", 1, "message", { text: "hello world" });
      const results = db.searchEvents("zzzznonexistent");
      expect(results).toHaveLength(0);
    });
  });
});
