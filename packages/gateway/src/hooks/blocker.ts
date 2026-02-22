/**
 * Approval blocker — manages pending hook requests that block until
 * the user approves or denies from the client.
 *
 * The critical mechanism: when a PreToolUse hook fires, the hook script
 * blocks (waits for response). This module manages those waiting hooks.
 */

export interface BlockingRequest {
  requestId: string;
  sessionId: string;
  resolve: (result: BlockerResult) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

export interface BlockerResult {
  /** false = approved (hook exits 0), true = denied (hook exits 2) */
  blocked: boolean;
  /** Reason for denial (sent back to agent) */
  reason?: string;
}

export class ApprovalBlocker {
  private pending = new Map<string, BlockingRequest>();

  /**
   * Register a blocking request. Returns a promise that resolves when
   * the user approves or denies, or when the timeout expires.
   */
  waitForApproval(
    requestId: string,
    sessionId: string,
    timeoutMs: number
  ): Promise<BlockerResult> {
    return new Promise<BlockerResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ blocked: true, reason: "Approval timed out" });
      }, timeoutMs);

      this.pending.set(requestId, {
        requestId,
        sessionId,
        resolve,
        timer,
        createdAt: Date.now(),
      });
    });
  }

  /**
   * Approve a pending request.
   */
  approve(requestId: string): boolean {
    const req = this.pending.get(requestId);
    if (!req) return false;

    clearTimeout(req.timer);
    this.pending.delete(requestId);
    req.resolve({ blocked: false });
    return true;
  }

  /**
   * Deny a pending request.
   */
  deny(requestId: string, reason?: string): boolean {
    const req = this.pending.get(requestId);
    if (!req) return false;

    clearTimeout(req.timer);
    this.pending.delete(requestId);
    req.resolve({ blocked: true, reason: reason || "Denied by user" });
    return true;
  }

  /**
   * Cancel all pending requests for a session (e.g., session stopped).
   */
  cancelSession(sessionId: string): void {
    for (const [id, req] of this.pending) {
      if (req.sessionId === sessionId) {
        clearTimeout(req.timer);
        this.pending.delete(id);
        req.resolve({ blocked: true, reason: "Session terminated" });
      }
    }
  }

  /**
   * Check if a request is pending.
   */
  isPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Get count of pending requests.
   */
  get size(): number {
    return this.pending.size;
  }
}
