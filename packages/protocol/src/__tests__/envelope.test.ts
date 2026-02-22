import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEnvelope } from "../envelope.js";
import { PROTOCOL_VERSION } from "../constants.js";

describe("createEnvelope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an envelope with correct fields", () => {
    const envelope = createEnvelope("permission_request", { toolName: "Bash" }, "sess-1", 1);

    expect(envelope).toEqual({
      v: PROTOCOL_VERSION,
      seq: 1,
      type: "permission_request",
      ts: "2026-02-20T12:00:00.000Z",
      sessionId: "sess-1",
      payload: { toolName: "Bash" },
    });
  });

  it("includes protocol version", () => {
    const envelope = createEnvelope("heartbeat", {}, null, 0);
    expect(envelope.v).toBe(PROTOCOL_VERSION);
    expect(envelope.v).toBe("1.0.0");
  });

  it("sets timestamp to ISO-8601 string", () => {
    const envelope = createEnvelope("test", {}, null, 0);
    expect(envelope.ts).toBe("2026-02-20T12:00:00.000Z");
    // Verify it's a valid ISO string
    expect(new Date(envelope.ts).toISOString()).toBe(envelope.ts);
  });

  it("handles null sessionId for system-level messages", () => {
    const envelope = createEnvelope("heartbeat", { serverTime: "now" }, null, 5);
    expect(envelope.sessionId).toBeNull();
  });

  it("preserves string sessionId", () => {
    const envelope = createEnvelope("session_start", {}, "abc-123-def", 0);
    expect(envelope.sessionId).toBe("abc-123-def");
  });

  it("preserves the seq number", () => {
    const envelope = createEnvelope("test", {}, null, 42);
    expect(envelope.seq).toBe(42);
  });

  it("preserves the payload type", () => {
    const payload = {
      requestId: "req-1",
      toolName: "Bash",
      toolCategory: "execute",
      toolInput: { command: "ls" },
      riskLevel: "safe" as const,
      summary: "ls",
      target: "ls",
    };
    const envelope = createEnvelope("permission_request", payload, "s1", 1);
    expect(envelope.payload).toEqual(payload);
  });

  it("creates envelopes with different types", () => {
    const types = [
      "session_start",
      "session_end",
      "permission_request",
      "tool_complete",
      "message",
      "heartbeat",
    ] as const;

    for (const type of types) {
      const envelope = createEnvelope(type, {}, null, 0);
      expect(envelope.type).toBe(type);
    }
  });
});
