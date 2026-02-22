import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ApprovalBlocker } from "../../src/hooks/blocker.js";

describe("ApprovalBlocker", () => {
  let blocker: ApprovalBlocker;

  beforeEach(() => {
    vi.useFakeTimers();
    blocker = new ApprovalBlocker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waitForApproval returns a promise", () => {
    const result = blocker.waitForApproval("req-1", "sess-1", 60_000);
    expect(result).toBeInstanceOf(Promise);
  });

  it("approve resolves with blocked: false", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);

    blocker.approve("req-1");

    const result = await promise;
    expect(result).toEqual({ blocked: false });
  });

  it("deny resolves with blocked: true and reason", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);

    blocker.deny("req-1", "Too risky");

    const result = await promise;
    expect(result).toEqual({ blocked: true, reason: "Too risky" });
  });

  it("deny without reason uses default message", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);

    blocker.deny("req-1");

    const result = await promise;
    expect(result).toEqual({ blocked: true, reason: "Denied by user" });
  });

  it("timeout auto-denies with 'Approval timed out'", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 5_000);

    // Advance time past the timeout
    vi.advanceTimersByTime(5_001);

    const result = await promise;
    expect(result).toEqual({ blocked: true, reason: "Approval timed out" });
  });

  it("timeout cleans up pending map", async () => {
    blocker.waitForApproval("req-1", "sess-1", 5_000);
    expect(blocker.isPending("req-1")).toBe(true);

    vi.advanceTimersByTime(5_001);

    // Allow the microtask to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(blocker.isPending("req-1")).toBe(false);
  });

  it("cancelSession cancels all pending for that session", async () => {
    const p1 = blocker.waitForApproval("req-1", "sess-A", 60_000);
    const p2 = blocker.waitForApproval("req-2", "sess-A", 60_000);
    const p3 = blocker.waitForApproval("req-3", "sess-B", 60_000);

    blocker.cancelSession("sess-A");

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual({ blocked: true, reason: "Session terminated" });
    expect(r2).toEqual({ blocked: true, reason: "Session terminated" });

    // sess-B should still be pending
    expect(blocker.isPending("req-3")).toBe(true);

    // Clean up
    blocker.approve("req-3");
    await p3;
  });

  it("isPending returns true for pending request", () => {
    blocker.waitForApproval("req-1", "sess-1", 60_000);
    expect(blocker.isPending("req-1")).toBe(true);
  });

  it("isPending returns false for non-existent request", () => {
    expect(blocker.isPending("req-nonexistent")).toBe(false);
  });

  it("isPending returns false after approval", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);
    blocker.approve("req-1");
    await promise;
    expect(blocker.isPending("req-1")).toBe(false);
  });

  it("isPending returns false after denial", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);
    blocker.deny("req-1");
    await promise;
    expect(blocker.isPending("req-1")).toBe(false);
  });

  it("cannot approve already-resolved request (returns false)", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);
    blocker.approve("req-1");
    await promise;

    // Second approve should return false
    const secondResult = blocker.approve("req-1");
    expect(secondResult).toBe(false);
  });

  it("cannot deny already-resolved request (returns false)", async () => {
    const promise = blocker.waitForApproval("req-1", "sess-1", 60_000);
    blocker.approve("req-1");
    await promise;

    const secondResult = blocker.deny("req-1", "too late");
    expect(secondResult).toBe(false);
  });

  it("approve returns true for pending request", () => {
    blocker.waitForApproval("req-1", "sess-1", 60_000);
    expect(blocker.approve("req-1")).toBe(true);
  });

  it("deny returns true for pending request", () => {
    blocker.waitForApproval("req-1", "sess-1", 60_000);
    expect(blocker.deny("req-1")).toBe(true);
  });

  it("size tracks pending count", async () => {
    expect(blocker.size).toBe(0);

    const p1 = blocker.waitForApproval("req-1", "sess-1", 60_000);
    expect(blocker.size).toBe(1);

    const p2 = blocker.waitForApproval("req-2", "sess-1", 60_000);
    expect(blocker.size).toBe(2);

    blocker.approve("req-1");
    await p1;
    expect(blocker.size).toBe(1);

    blocker.deny("req-2");
    await p2;
    expect(blocker.size).toBe(0);
  });

  it("multiple concurrent requests for different sessions", async () => {
    const p1 = blocker.waitForApproval("req-1", "sess-A", 60_000);
    const p2 = blocker.waitForApproval("req-2", "sess-B", 60_000);

    blocker.deny("req-1", "no");
    blocker.approve("req-2");

    const r1 = await p1;
    const r2 = await p2;

    expect(r1).toEqual({ blocked: true, reason: "no" });
    expect(r2).toEqual({ blocked: false });
  });
});
