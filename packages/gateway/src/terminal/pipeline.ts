import { FRAME_INTERVAL_MS } from "@agentpager/protocol";

/**
 * Frame coalescing pipeline for terminal output streaming.
 * Batches PTY output into ~16ms frames (60fps) to prevent flooding clients.
 */
export class TerminalPipeline {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFrame: (data: string) => void;
  private intervalMs: number;

  constructor(onFrame: (data: string) => void, intervalMs = FRAME_INTERVAL_MS) {
    this.onFrame = onFrame;
    this.intervalMs = intervalMs;
  }

  /**
   * Push new data into the pipeline.
   * Data is batched and flushed on the next frame interval.
   */
  push(data: string): void {
    this.buffer += data;

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.intervalMs);
    }
  }

  /**
   * Flush buffered data immediately.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length > 0) {
      const data = this.buffer;
      this.buffer = "";
      this.onFrame(data);
    }
  }

  /**
   * Stop the pipeline and flush remaining data.
   */
  stop(): void {
    this.flush();
  }
}
